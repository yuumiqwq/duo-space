import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCollaborationSnapshot, mergeCollaborationSnapshot } from '../app/collaboration-loading.ts';

const member = id => ({ id, name: id, connected: true, loading: true, tasks: [] });
const local = () => ({ identityId: 'alice', revision: 2, buffer: [{ id: 'public' }], workflows: [{ id: 'workflow', status: 'working' }], operations: [], members: [member('alice'), member('bob')] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('local records and one inbox render before a stalled peer, and loading settles independently', async () => {
  const slow = deferred(), first = deferred(), complete = deferred(), requests = [];
  let current = null, settled = false;
  const controller = new AbortController();
  const result = await loadCollaborationSnapshot({ signal: controller.signal,
    request: async url => {
      requests.push(url);
      if (url.endsWith('local=1')) return Response.json(local());
      const id = url.endsWith('alice') ? 'alice' : 'bob';
      if (id === 'bob') await slow.promise;
      return Response.json({ ...local(), members: [{ ...member(id), loading: false, tasks: [{ id: id + '-task' }] }] });
    },
    accept: (next, id) => { current = mergeCollaborationSnapshot(current, next, id); if (id === 'alice') first.resolve(); },
    settled: () => { settled = true; complete.resolve(); },
  });
  assert.equal(result.buffer[0].id, 'public');
  await first.promise;
  assert.equal(current.members[0].tasks[0].id, 'alice-task'); assert.ok(current.members[1].loading);
  assert.equal(settled, false); assert.equal(requests.length, 3);
  slow.resolve(); await complete.promise;
  assert.equal(current.members[1].tasks[0].id, 'bob-task'); assert.equal(settled, true);
});

test('failed member reads are isolated and aborted old responses cannot update the board', async () => {
  const slow = deferred(), complete = deferred();
  const controller = new AbortController(); let current = null, updates = 0;
  await loadCollaborationSnapshot({ signal: controller.signal,
    request: async url => {
      if (url.endsWith('local=1')) return Response.json(local());
      if (url.endsWith('alice')) return Response.json({ error: '收集箱暂时无法读取' }, { status: 503 });
      await slow.promise;
      return Response.json({ ...local(), members: [{ ...member('bob'), tasks: [{ id: 'old-task' }] }] });
    },
    accept: (next, id) => { current = mergeCollaborationSnapshot(current, next, id); updates++; },
    settled: complete.resolve,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(current.members[0].error, /收集箱/); assert.equal(current.buffer.length, 1);
  const before = updates; controller.abort(); slow.resolve(); await complete.promise;
  assert.equal(updates, before); assert.equal(current.members[1].tasks.length, 0);
});

test('independent refreshes retain loaded members and latest workflow records without resurrecting deleted tasks', () => {
  const snapshot = { ...local(), members: [{ ...member('alice'), loading: false, tasks: [{ id: 'original' }] }, member('bob')] };
  const refresh = mergeCollaborationSnapshot(snapshot, { ...local(), revision: 3, workflows: [] });
  assert.deepEqual(refresh.members[0], snapshot.members[0]); assert.deepEqual(refresh.workflows, []);
  const deleted = { id: 'workflow', status: 'deleted', source: { ownerId: null, taskId: 'public' }, claimantId: 'bob', targetId: 'deleted-task', events: [] };
  const current = { ...refresh, revision: 4, buffer: [], workflows: [deleted] };
  const oldMember = { ...local(), members: [{ ...member('bob'), tasks: [{ id: 'deleted-task' }, { id: 'other-task' }] }] };
  const result = mergeCollaborationSnapshot(current, oldMember, 'bob');
  assert.equal(result.revision, 4); assert.deepEqual(result.workflows, [deleted]); assert.deepEqual(result.buffer, []);
  assert.deepEqual(result.members[1].tasks, [{ id: 'other-task' }]);
  assert.deepEqual(mergeCollaborationSnapshot(result, { ...oldMember, identityId: 'different' }, 'bob'), result);
});
