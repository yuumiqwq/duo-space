import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { tickFetch, tickInboxData } from '../app/api/ticktick/client.ts';
import { createTodoStore } from '../app/api/room/todo/store.ts';
import { classroomTodoWindow } from '../app/classroom-todo.ts';
import { taskRefresh } from '../app/task-refresh.ts';
import { refreshMembers, remoteTaskSignatures } from '../app/collaboration-refresh.ts';
import { loadCollaborationSnapshot } from '../app/collaboration-loading.ts';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
test('concurrent reads share transport, completed reads are not cached, mutations isolate stale responses, and tokens stay separate', async () => {
  const original = globalThis.fetch, gate = deferred(), entered = deferred(); let reads = 0;
  globalThis.fetch = async (_, init) => {
    if (init.method === 'POST') return new Response(null, { status: 204 });
    const sequence = ++reads;
    if (sequence === 1) { entered.resolve(); await gate.promise; }
    return Response.json({ sequence, token: init.headers.Authorization });
  };
  try {
    const token = randomUUID(), a = tickFetch('/project', token), b = tickFetch('/project', token);
    await entered.promise;
    assert.equal(reads, 1);
    await tickFetch('/task', token, { method: 'POST' });
    assert.equal((await (await tickFetch('/project', token)).json()).sequence, 2);
    gate.resolve(); assert.deepEqual(await (await a).json(), await (await b).json());
    assert.equal((await (await tickFetch('/project', token)).json()).sequence, 3);
    assert.equal((await (await tickFetch('/project', 'other-token')).json()).token, 'Bearer other-token');
  } finally { gate.resolve(); globalThis.fetch = original; }
});

test('an empty inbox never waits for optional metadata', async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async url => { calls.push(url); assert.ok(url.endsWith('/project/inbox/data')); return Response.json({ tasks: [] }); };
  try { assert.deepEqual(await tickInboxData(randomUUID()), { projectId: 'inbox', tasks: [] }); assert.equal(calls.length, 1); }
  finally { globalThis.fetch = original; }
});

test('website transitions do not invalidate Dida signatures and scoped refresh omits unmodified accounts', async () => {
  const workflow = { id: 'w', claimantId: 'bob', reviewerId: 'alice', source: { ownerId: null }, fields: { title: 'task' }, targetId: 't', events: [], status: 'working' };
  const baseline = remoteTaskSignatures([workflow], []);
  for (const status of ['submitted', 'rejected']) assert.deepEqual(remoteTaskSignatures([{ ...workflow, status, executing: true, events: [{ id: status, type: status === 'submitted' ? 'submit' : 'reject' }] }], []), baseline);
  assert.notDeepEqual(remoteTaskSignatures([{ ...workflow, status: 'done' }], []), baseline);
  const snapshot = { workflows: [workflow], members: [{ id: 'alice', connected: true }, { id: 'bob', connected: true }], operations: [] };
  for (const action of ['submit', 'reject', 'arrange-execution', 'nudge']) assert.deepEqual(refreshMembers({ id: 'c', action, workflowId: 'w' }, snapshot), []);
  assert.deepEqual(refreshMembers({ id: 'c', action: 'approve', workflowId: 'w' }, snapshot), ['bob']);
  for (const memberIds of [[], ['bob']]) {
    const calls = [], settled = deferred();
    await loadCollaborationSnapshot({ signal: new AbortController().signal, memberIds, accept() {}, settled: settled.resolve,
      request: async url => { calls.push(url); return Response.json({ ...snapshot, identityId: 'alice', revision: 1, buffer: [], members: url.endsWith('local=1') ? snapshot.members : [snapshot.members[1]] }); },
    });
    await settled.promise;
    assert.deepEqual(calls, ['/api/room/tasks?local=1', ...memberIds.map(id => '/api/room/tasks?member=' + id)]);
  }
});

test('overlapping page loads coalesce but an acknowledged write schedules fresh data after a stale preload', async () => {
  const gate = deferred(); let calls = 0;
  const refresh = taskRefresh(async () => { const call = ++calls; if (call === 1) await gate.promise; return call; });
  const a = refresh(), b = refresh(); assert.equal(a, b); assert.equal(calls, 1);
  const afterWrite = refresh(true); refresh(true); assert.equal(afterWrite, a);
  gate.resolve(); assert.equal(await afterWrite, 2); assert.equal(calls, 2);
  assert.equal(await refresh(), 3);
});

test('connection validation reads only the inbox; partial daily failures preserve the failed coverage and auth expiry remains visible', async () => {
  await mkdir('codex-generated/test-data', { recursive: true });
  const dir = await mkdtemp(path.resolve('codex-generated/test-data/read-routes-'));
  const original = globalThis.fetch, originalStore = globalThis.didaTestTodo;
  globalThis.didaTestTodo = createTodoStore(dir); globalThis.didaTestSaved = 0;
  const plugin = { name: 'isolated-dependencies', setup(builder) {
    builder.onResolve({ filter: /^next\/server$/ }, () => ({ path: 'response', namespace: 'fixture' }));
    builder.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: 'credentials', namespace: 'fixture' }));
    builder.onResolve({ filter: /identity\/session$/ }, () => ({ path: 'identity', namespace: 'fixture' }));
    builder.onResolve({ filter: /room\/todo\/store$/ }, () => ({ path: 'todo', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: {
      response: 'export class NextResponse extends Response { cookies = { set() {} }; static json(value, init) { return new NextResponse(JSON.stringify(value), init); } }',
      credentials: 'export async function accessToken() { return "isolated"; } export async function saveAccessToken() { globalThis.didaTestSaved++; return true; } export async function clearAccessToken() {}',
      identity: 'export async function currentIdentityId() { return "alice"; }',
      todo: 'export const todoStore = globalThis.didaTestTodo;',
    }[args.path] }));
  } };
  try {
    const routes = {};
    for (const name of ['token', 'tasks']) {
      const output = path.join(dir, name + '.mjs');
      await build({ entryPoints: [`app/api/ticktick/${name}/route.ts`], bundle: true, platform: 'node', format: 'esm', outfile: output, logLevel: 'silent', plugins: [plugin] });
      routes[name] = await import(pathToFileURL(output).href);
    }
    let failure = false, expired = false; const calls = [];
    const dueDate = new Date(classroomTodoWindow().start + 3600000).toISOString();
    globalThis.fetch = async url => {
      const route = new URL(url).pathname.replace('/open/v1', ''); calls.push(route);
      if (expired) return new Response(null, { status: 401 });
      if (route === '/project/inbox/data') return Response.json({ project: { id: 'inbox-id' }, tasks: [] });
      if (route === '/task/completed') return Response.json([]);
      if (route === '/project') return Response.json([{ id: 'healthy', name: 'healthy' }, { id: 'failed', name: 'failed' }]);
      if (route === '/project/failed/data' && failure) return new Response(null, { status: 503 });
      const id = route.includes('/healthy/') ? 'healthy' : 'failed';
      return Response.json({ tasks: failure && id === 'healthy' ? [] : [{ id, projectId: id, title: id, dueDate }] });
    };
    const connected = await routes.token.POST(new Request('http://localhost/token', { method: 'POST', body: JSON.stringify({ token: 'test-token-long-enough' }) }));
    assert.equal(connected.status, 200); assert.equal(globalThis.didaTestSaved, 1); assert.deepEqual(calls, ['/project/inbox/data']);
    const get = async () => routes.tasks.GET(new Request('http://localhost/tasks?view=today&classroom=1'));
    const initial = await (await get()).json(); assert.equal(initial.tasks.length, 2);
    failure = true;
    const partial = await (await get()).json(); assert.deepEqual(partial.tasks.map(task => task.id), ['failed']); assert.ok(partial.inboxError);
    assert.deepEqual(partial.failedProjectIds, ['failed']);
    expired = true; assert.equal((await get()).status, 401);
  } finally { globalThis.fetch = original; globalThis.didaTestTodo = originalStore; delete globalThis.didaTestSaved; }
});
