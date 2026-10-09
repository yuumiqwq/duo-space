import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { filterTasksByView, tickFetch, tickInboxData } from '../app/api/ticktick/client.ts';

test('today, week and undated views separate dates and retain every undated task', () => {
  const tasks = [
    { id: 'old', dueDate: '2026-09-05T10:00:00+0800' },
    { id: 'today', dueDate: '2026-09-07T10:00:00+0800' },
    { id: 'week', startDate: '2026-09-10T10:00:00+0800' },
    { id: 'future', dueDate: '2026-10-01T10:00:00+0800' },
    { id: 'done', status: 2 },
    ...Array.from({ length: 61 }, (_, i) => ({ id: 'undated-' + i })),
  ].map(t => ({ title: t.id, projectId: 'inbox', ...t }));
  const now = Date.parse('2026-09-07T01:00:00Z');
  assert.deepEqual(filterTasksByView(tasks, 'today', now).map(t => t.id), ['old', 'today']);
  assert.deepEqual(filterTasksByView(tasks, 'week', now).map(t => t.id), ['old', 'today', 'week']);
  assert.equal(filterTasksByView(tasks, 'undated', now).length, 61);
});

test('recipient credentials resolve the inbox and create an undated task', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json(url.endsWith('/project/inbox/data') ? { project: { id: 'inbox-recipient' }, tasks: [] } : { id: 'created' });
  };
  try {
    const inbox = await tickInboxData('recipient-token');
    await tickFetch('/task', 'recipient-token', { method: 'POST', body: JSON.stringify({ title: '中文待办', projectId: inbox.projectId }) });
    assert.equal(calls[0].init.headers.Authorization, 'Bearer recipient-token');
    assert.equal(calls[1].init.headers.Authorization, 'Bearer recipient-token');
    assert.deepEqual(JSON.parse(calls[1].init.body), { title: '中文待办', projectId: 'inbox-recipient' });
  } finally { globalThis.fetch = original; }
});

test('cross-member records persist, deduplicate retries and acknowledge only displayed records for the recipient', async () => {
  await mkdir('codex-generated/test-data', { recursive: true });
  process.env.DATA_DIR = await mkdtemp(path.resolve('codex-generated/test-data/shared-'));
  const store = await import('../app/api/ticktick/shared-store.ts');
  const otherRoute = await import('../app/api/ticktick/shared-store.ts?other-route');
  let calls = 0;
  const external = async () => { calls++; return { taskId: 'task-' + calls, projectId: 'inbox-bob' }; };
  const input = { id: 'one', senderId: 'alice', recipientId: 'bob', senderName: 'Alice', title: '准备习题' };
  const [a, b] = await Promise.all([store.createSharedTask(input, external), otherRoute.createSharedTask(input, external)]);
  assert.equal(calls, 1); assert.equal(a.taskId, b.taskId);
  assert.equal((await store.unreadSharedTasks('alice')).length, 0);
  const displayed = await store.unreadSharedTasks('bob');
  await store.createSharedTask({ ...input, id: 'two', title: '整理笔记' }, external);
  await store.markSharedTasksRead('alice', ['one', 'two']);
  assert.equal((await store.unreadSharedTasks('bob')).length, 2);
  await store.markSharedTasksRead('bob', displayed.map(r => r.id));
  assert.deepEqual((await store.unreadSharedTasks('bob')).map(r => r.id), ['two']);
  await assert.rejects(store.createSharedTask({ ...input, recipientId: 'charlie' }, external), { status: 409 });
  await assert.rejects(store.createSharedTask({ ...input, id: 'unknown' }, async () => { throw new Error('Lost network response'); }));
  await assert.rejects(store.createSharedTask({ ...input, id: 'unknown' }, external), { status: 409 });
  assert.equal(calls, 2);
  const reloaded = await import('../app/api/ticktick/shared-store.ts?restart');
  assert.deepEqual((await reloaded.unreadSharedTasks('bob')).map(r => r.id), ['two']);
  await assert.rejects(reloaded.createSharedTask({ ...input, id: 'unknown' }, external), { status: 409 });
  await reloaded.markSharedTasksRead('bob', ['two']);
  assert.equal((await reloaded.unreadSharedTasks('bob')).length, 0);
  await reloaded.createSharedTask({ ...input, id: 'three' }, external);
  assert.equal((await reloaded.unreadSharedTasks('bob')).length, 1);
});
