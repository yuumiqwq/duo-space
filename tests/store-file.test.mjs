import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeStoreFile } from '../app/api/store-file.ts';
import { fileStoreQueue } from '../app/api/store-queue.ts';
import { BoardDeletionStore } from '../app/api/room/boards/store.ts';
import { createTodoStore } from '../app/api/room/todo/store.ts';

async function fixture(t) {
  const root = path.resolve('codex-generated/test-data');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'store-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('atomic store publication preserves exact bytes and cleans its temporary on replacement failure', async t => {
  const directory = await fixture(t), file = path.join(directory, 'nested/state.json');
  await writeStoreFile(file, '{ "version": 1 }\n');
  assert.equal(await readFile(file, 'utf8'), '{ "version": 1 }\n');
  await writeStoreFile(file, '{"version":2}');
  assert.equal(await readFile(file, 'utf8'), '{"version":2}');
  const blocked = path.join(directory, 'existing-directory');
  await mkdir(blocked);
  await writeFile(path.join(blocked, 'retained'), 'keep');
  await assert.rejects(writeStoreFile(blocked, 'replacement'));
  assert.equal(await readFile(path.join(blocked, 'retained'), 'utf8'), 'keep');
  assert.deepEqual((await readdir(directory)).sort(), ['existing-directory', 'nested']);
  assert.deepEqual(await readdir(path.dirname(file)), ['state.json']);
});

test('normalized file queues coordinate module copies and continue after a failed transaction', async t => {
  const directory = await fixture(t), file = path.join(directory, 'state.json');
  const copy = await import('../app/api/store-queue.ts?independent-bundle');
  const first = fileStoreQueue(file), second = copy.fileStoreQueue(path.join(directory, 'unused/../state.json'));
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const order = [];
  const failed = first.run(async () => { order.push('first'); await waiting; throw new Error('fixture failure'); });
  const rejection = assert.rejects(failed, /fixture failure/);
  const resumed = second.run(async () => { order.push('second'); return 'saved'; });
  await Promise.resolve();
  assert.deepEqual(order, ['first']);
  release();
  await rejection;
  assert.equal(await resumed, 'saved');
  await first.settled();
  assert.deepEqual(order, ['first', 'second']);
});

test('independent board and todo store instances retain concurrent records for the same directory', async t => {
  const directory = await fixture(t);
  const boards = [new BoardDeletionStore(directory), new BoardDeletionStore(directory)];
  await Promise.all(Array.from({ length: 24 }, (_, index) => boards[index % 2].delete(`board-${index}`)));
  assert.equal((await new BoardDeletionStore(directory).read()).length, 24);
  const todos = [createTodoStore(directory), createTodoStore(directory)];
  const now = Date.parse('2026-10-09T04:00:00Z');
  await Promise.all(Array.from({ length: 24 }, (_, index) => todos[index % 2].reconcile(`member-${index}`, [
    { id: `task-${index}`, title: 'Fixture', project: 'Inbox', dueDate: '2026-10-09', isAllDay: true, done: false },
  ], now)));
  const state = JSON.parse(await readFile(path.join(directory, 'classroom-todo.json'), 'utf8'));
  assert.equal(Object.keys(state.members).length, 24);
});

test('independent identity route bundles preserve concurrent members and their existing settings', async t => {
  const directory = await fixture(t), previous = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  try {
    const suffix = crypto.randomUUID();
    const first = await import(`../app/api/identity/store.ts?first=${suffix}`);
    const second = await import(`../app/api/identity/store.ts?second=${suffix}`);
    await Promise.all(Array.from({ length: 24 }, (_, index) => (index % 2 ? first : second).updateUser(`member-${index}`, () => ({ nickname: `Member ${index}`, updatedAt: 'fixture' }))));
    assert.equal((await first.listRoomMembers()).length, 24);
    await Promise.all([
      first.updateUser('member-0', current => ({ ...current, activity: 'study' })),
      second.updateUser('member-0', current => ({ ...current, todoNote: 'note' })),
    ]);
    assert.deepEqual(await first.getUser('member-0'), { nickname: 'Member 0', updatedAt: 'fixture', activity: 'study', todoNote: 'note' });
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
  }
});
