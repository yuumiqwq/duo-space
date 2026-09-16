import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { encryptToken } from '../app/api/ticktick/crypto.ts';
import { CollaborationStore, remoteVersion, taskFields } from '../app/api/room/tasks/store.ts';

async function freePort() { const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port; }
async function until(check, timeout = 28000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 150)); } assert.fail('background recovery timed out'); }

test('production startup recovers saved updates without a logged-in page, while a shared-data candidate stays inactive', { timeout: 90000 }, async () => {
  await mkdir('codex-generated/test-data', { recursive: true });
  const dir = await mkdtemp(path.resolve('codex-generated/test-data/task-background-'));
  const secret = randomUUID(), previous = process.env.TICKTICK_STORAGE_SECRET;
  process.env.TICKTICK_STORAGE_SECRET = secret;
  const users = { alice: { nickname: 'Alice', ticktickToken: encryptToken('fixture-alice') } };
  if (previous === undefined) delete process.env.TICKTICK_STORAGE_SECRET; else process.env.TICKTICK_STORAGE_SECRET = previous;
  await writeFile(path.join(dir, 'identities.json'), JSON.stringify({ version: 1, users }));
  const remoteFile = path.join(dir, 'fake-dida.json'), stateFile = path.join(dir, 'room-collaboration.json');
  const initial = { id: 'background-task', projectId: 'inbox-alice', ...taskFields({ title: 'background', content: 'keep note' }) };
  await writeFile(remoteFile, JSON.stringify({ alice: { [initial.id]: initial }, bob: {} }));
  async function seed(priority) {
    const current = JSON.parse(await readFile(remoteFile, 'utf8')).alice[initial.id];
    const store = new CollaborationStore(dir, { members: async () => [{ id: 'alice', name: 'Alice', connected: true }], get: async () => current,
      update: async () => { throw new Error('saved before service restart'); } });
    const id = randomUUID();
    assert.equal((await store.execute('alice', { id, action: 'update', source: { ownerId: 'alice', taskId: initial.id, version: remoteVersion(current) }, fields: { priority } })).status, 'pending');
    return id;
  }
  const id = await seed(5), port = await freePort(), candidatePort = await freePort(), origin = `http://127.0.0.1:${port}`;
  const children = [];
  function start(atPort, label) {
    const child = spawn(process.execPath, ['--import', './tests/helpers/dida-fixture.mjs', 'node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(atPort)],
      { env: { ...process.env, DATA_DIR: dir, TICKTICK_STORAGE_SECRET: secret, AUTH_SESSION_SECRET: secret, TASK_SYNC_ORIGIN: origin, TASK_SYNC_DISABLED: '0', DIDA_FIXTURE_PROCESS: label, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' }, stdio: 'ignore', windowsHide: true });
    children.push(child); return child;
  }
  async function stop(child) { if (child.exitCode !== null || child.signalCode !== null) return; const ended = once(child, 'exit'); child.kill(); await ended; }
  try {
    start(candidatePort, 'candidate'); let main = start(port, 'production');
    const firstRuntime = await until(async () => { try { return await (await fetch(origin + '/api/access/runtime')).json(); } catch { return false; } });
    await until(async () => JSON.parse(await readFile(stateFile, 'utf8')).operations[id].status === 'done');
    let current = JSON.parse(await readFile(remoteFile, 'utf8')).alice[initial.id];
    assert.equal(current.priority, 5); assert.equal(current.content, 'keep note'); assert.equal(current.fixtureUpdateWriter, 'production');
    const candidate = await (await fetch(`http://127.0.0.1:${candidatePort}/api/access/runtime`)).json();
    assert.notEqual(candidate.instanceId, firstRuntime.instanceId); assert.equal(candidate.active, false); assert.equal(candidate.lastRunAt, null);
    await stop(main);
    const nextId = await seed(1); main = start(port, 'restarted-production');
    await until(async () => JSON.parse(await readFile(stateFile, 'utf8')).operations[nextId].status === 'done');
    current = JSON.parse(await readFile(remoteFile, 'utf8')).alice[initial.id];
    assert.equal(current.priority, 1); assert.equal(current.fixtureUpdateWriter, 'restarted-production');
    const restarted = await (await fetch(origin + '/api/access/runtime')).json();
    assert.notEqual(restarted.instanceId, firstRuntime.instanceId); assert.equal(restarted.active, true);
  } finally { await Promise.all(children.map(stop)); }
});
