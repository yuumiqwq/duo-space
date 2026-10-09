import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { reconcilePendingRings } from '../app/ring-reconciliation.ts';

const source = readFileSync('app/RoomBell.tsx', 'utf8');
const tree = ts.createSourceFile('RoomBell.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'refresh') declarations.push(`const ${node.getText(tree)};`);
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'act') declarations.push(node.getText(tree));
  ts.forEachChild(node, visit);
}
visit(tree);
const code = ts.transpileModule(declarations.join('\n') + '\nreturn { act, refresh };', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test('a lost ring response is reconciled without duplicates and a later explicit send creates a new ring', async () => {
  const root = path.resolve('codex-generated/test-data');
  await mkdir(root, { recursive: true });
  process.env.DATA_DIR = await mkdtemp(path.join(root, 'ring-recovery-'));
  const store = await import('../app/api/room/rings/store.ts');
  let now = Date.now(), loseResponse = true, failReads = true;
  const posts = [];
  const env = {
    reconcilePendingRings, useCallback: fn => fn, crypto,
    locked: { current: false }, sequence: { current: 0 }, pending: { current: {} }, offset: { current: 0 },
    setBusy() {}, setError() {}, setNow() {}, setData() {}, setOffline() {}, navigator: {}, Date: { now: () => now },
    fetch: async (_url, init) => {
      if (!init.method) {
        if (failReads) throw Error('offline');
        return Response.json({ identityId: 'alice', rings: await store.listRings('alice', now), serverNow: now, members: [] });
      }
      const body = JSON.parse(init.body);
      const result = await store.startRing({ ...body, senderId: 'alice', senderName: 'Alice', recipientName: 'Bob' }, now);
      posts.push(result);
      if (loseResponse) { loseResponse = false; throw Error('response lost'); }
      return Response.json(result);
    },
  };
  const actions = new Function(...Object.keys(env), code)(...Object.values(env));
  await actions.act('bob');
  assert.equal(posts.length, 1);
  assert.equal(env.pending.current.bob, posts[0].ring.id);
  failReads = false;
  await actions.act('bob');
  assert.equal(posts.length, 1, 'read-back must confirm the live ring without posting again');
  assert.equal(env.pending.current.bob, undefined);
  now += 121000;
  // Reproduce an old pending id that has not yet been reconciled by a poll.
  env.pending.current.bob = posts[0].ring.id;
  await actions.act('bob');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].created, true);
  assert.notEqual(posts[1].ring.id, posts[0].ring.id);
  assert.equal((await store.listRings('bob', now)).filter(ring => ring.state === 'active').length, 1);
});
