import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

test('existing incompatible identity files reject reads and both write paths without changing bytes', async t => {
  const parent = path.resolve('codex-generated/review-fixes-20261009/server/test-data');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'identity-'));
  process.env.DATA_DIR = directory;
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await import(`../app/api/identity/store.ts?fixture=${randomUUID()}`);
  const filename = path.join(directory, 'identities.json');
  for (const value of [
    { version: 2, users: { alice: { nickname: 'Alice' }, bob: { ticktickToken: 'fixture-token' } } },
    { version: 1, users: [] }, { version: 1, users: null }, { version: 1, users: { alice: null } },
    { version: 1, users: { alice: { activity: 42 } } },
    { version: 1, users: {}, classroom: { seats: 'alice' } }, null, [], 'invalid JSON',
  ]) {
    const original = typeof value === 'string' ? value : JSON.stringify(value);
    await writeFile(filename, original);
    await assert.rejects(store.getUser('alice'));
    await assert.rejects(store.updateUser('alice', () => ({ nickname: 'Changed', updatedAt: 'now' })));
    await assert.rejects(store.updateClassroomProfile('alice', { action: 'save-settings', seat: 'tablet' }));
    assert.equal(await readFile(filename, 'utf8'), original);
    assert.deepEqual(await readdir(directory), ['identities.json']);
  }
  // Old v1 timestamps are optional; unknown fields must survive compatible edits.
  await writeFile(filename, JSON.stringify({ version: 1, legacy: 'preserve', users: { alice: { nickname: 'Alice' }, bob: { ticktickToken: 'fixture-token' } }, classroom: { seats: ['alice', 'bob'], font: 'legacy' } }));
  await store.updateUser('alice', current => ({ ...current, activity: 'study', updatedAt: 'now' }));
  const saved = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(saved.legacy, 'preserve');
  assert.equal(saved.users.bob.ticktickToken, 'fixture-token');
  assert.equal(saved.classroom.font, 'legacy');
  await store.updateClassroomProfile('alice', { action: 'save-settings', seat: 'laptop' });
  assert.deepEqual((await store.getClassroomProfile()).seats, ['bob', 'alice']);
  await rm(filename);
  assert.equal(await store.getUser('alice'), null);
  await store.updateUser('alice', () => ({ nickname: 'New', updatedAt: 'now' }));
  assert.equal((await store.getUser('alice')).nickname, 'New');
});
