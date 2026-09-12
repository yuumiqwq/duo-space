import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { encryptToken } from '../app/api/ticktick/crypto.ts';
import { CollaborationStore, remoteVersion, taskFields } from '../app/api/room/tasks/store.ts';
import { randomUUID } from 'node:crypto';

test('Dida provider works with Open API credentials despite V2 rejection and scopes transfers to the owner inbox', async () => {
  await mkdir('codex-generated/test-data', { recursive: true });
  const dir = await mkdtemp(path.resolve('codex-generated/test-data/cooperation-provider-'));
  const previousDir = process.env.DATA_DIR, previousSecret = process.env.TICKTICK_STORAGE_SECRET;
  process.env.DATA_DIR = dir; process.env.TICKTICK_STORAGE_SECRET = 'synthetic-test-key';
  const originalFetch = globalThis.fetch;
  try {
    await writeFile(path.join(dir, 'identities.json'), JSON.stringify({ version: 1, users: { alice: { nickname: 'Alice', ticktickToken: encryptToken('token-alice') }, bob: { nickname: 'Bob', ticktickToken: encryptToken('token-bob') } } }));
    const output = path.join(dir, 'provider.mjs');
    await build({ entryPoints: ['app/api/room/tasks/provider.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output, logLevel: 'silent' });
    const { gateway } = await import(pathToFileURL(output).href);
    const accounts = { alice: new Map(), bob: new Map() }, requests = [];
    let comments = [], wrongProject = false, allocatedId = null, omitReceipt = false, normalizeWrites = false, inboxGate = null;
    const providerFields = task => normalizeWrites ? { ...task, dueDate: task.dueDate ?? task.startDate, items: task.items.map((item, index) => ({ ...item, id: `allocated-item-${index}` })) } : task;
    globalThis.fetch = async (url, init) => {
      const owner = String(init.headers.Authorization).replace('Bearer token-', '');
      assert.ok(Object.hasOwn(accounts, owner), 'request uses the selected owner token');
      const route = new URL(url).pathname, method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ owner, route, method, body });
      if (route === '/api/v2/batch/check/0') return new Response(null, { status: 401 });
      if (route === '/open/v1/project/inbox/data') { if (inboxGate) await inboxGate(); return Response.json({ tasks: [...accounts[owner].values()], columns: [] }); }
      if (route === '/open/v1/project/inbox') return Response.json({ id: `inbox-${owner}` });
      if (route === '/open/v1/task/batch') {
        for (const task of body.add || []) { assert.equal(task.projectId, `inbox-${owner}`); const actual = providerFields({ ...structuredClone(task), id: allocatedId || task.id }); accounts[owner].set(actual.id, actual); }
        for (const task of body.update || []) { assert.equal(task.projectId, `inbox-${owner}`); accounts[owner].set(task.id, { ...task, etag: 'reopened' }); }
        return Response.json({ id2etag: omitReceipt ? {} : Object.fromEntries((body.add || body.update).map(task => [allocatedId || task.id, "etag"])) });
      }
      if (method === 'POST' && /^\/open\/v1\/task\/[^/]+$/.test(route)) {
        assert.equal(body.projectId, `inbox-${owner}`); accounts[owner].set(body.id, providerFields(structuredClone(body))); return Response.json(body);
      }
      assert.ok(route.startsWith(`/open/v1/project/inbox-${owner}/`), 'project route cannot use another owner inbox');
      if (route.endsWith('/data')) return Response.json({ tasks: [...accounts[owner].values(), { id: 'outside', projectId: 'other-list' }] });
      if (route.endsWith('/comments')) return Response.json(comments);
      const id = route.split('/')[6];
      if (method === 'DELETE') { return new Response(null, { status: accounts[owner].delete(id) ? 204 : 404 }); }
      if (route.endsWith('/complete')) { accounts[owner].get(id).status = 2; return new Response(null, { status: 204 }); }
      const task = accounts[owner].get(id);
      return task ? Response.json({ ...task, ...(wrongProject ? { projectId: 'foreign' } : {}) }) : new Response(null, { status: 404 });
    };
    const fields = taskFields({ title: '跨账户完整字段', content: '说明', desc: '检查项说明', kind: 'CHECKLIST', items: [{ id: 'item1', title: '检查项', status: 0 }], priority: 5, startDate: '2026-09-09T01:00:00.000Z', dueDate: '2026-09-09T02:00:00.000Z', tags: ['study'], reminders: ['TRIGGER:-PT15M'], repeatFlag: 'RRULE:FREQ=WEEKLY;INTERVAL=1', repeatFrom: '1', isAllDay: false });
    await gateway.create('bob', 'stable-task-id', fields);
    await gateway.create('bob', 'stable-task-id', fields);
    assert.equal(requests.filter(request => request.route.endsWith('/task/batch')).length, 1);
    assert.equal(accounts.alice.size, 0);
    assert.equal(accounts.bob.get('stable-task-id').startDate, '2026-09-09T01:00:00+0000');
    let task = await gateway.get('bob', 'stable-task-id');
    assert.deepEqual(task.items, fields.items); assert.equal(task.repeatFrom, '1');
    task.providerMetadata = { preserved: true }; accounts.bob.set(task.id, task);
    await gateway.update('bob', task.id, { ...fields, title: '修改优先级', priority: 3 }, remoteVersion(task));
    assert.deepEqual(accounts.bob.get(task.id).providerMetadata, { preserved: true });
    await assert.rejects(gateway.update('bob', task.id, fields, remoteVersion(task)), /刚被修改/);
    task = await gateway.get('bob', task.id);
    assert.equal((await gateway.inbox('bob')).tasks.length, 1);
    wrongProject = true;
    await assert.rejects(gateway.get('bob', task.id), { status: 403 }); wrongProject = false;
    await gateway.checkTransfer('bob', task);
    comments = [{ id: 'comment' }]; await assert.rejects(gateway.checkTransfer('bob', task), /评论/); comments = [];
    await assert.rejects(gateway.checkTransfer('bob', { ...task, attachments: [{}] }), /附件/);
    await assert.rejects(gateway.checkTransfer('bob', { ...task, attachments: { count: 1 } }), /附件/);
    await assert.rejects(gateway.checkTransfer('bob', { ...task, focusSummaries: [{}] }), /专注历史/);
    accounts.bob.set('child', { id: 'child', projectId: 'inbox-bob', parentId: task.id });
    await assert.rejects(gateway.checkTransfer('bob', task), /子任务/); accounts.bob.delete('child');
    await gateway.complete('bob', task.id); assert.equal(accounts.bob.get(task.id).status, 2);
    const completed = await gateway.get('bob', task.id);
    const reopened = await gateway.reopen('bob', completed);
    assert.equal(reopened.status, 0); assert.equal(reopened.completedTime, null);
    assert.deepEqual(reopened.providerMetadata, { preserved: true }); assert.deepEqual(taskFields(reopened), taskFields(completed));
    const writes = requests.filter(request => request.method === 'POST').length;
    await gateway.reopen('bob', completed); assert.equal(requests.filter(request => request.method === 'POST').length, writes);
    accounts.bob.get(task.id).status = 2; accounts.bob.get(task.id).title = 'concurrent edit';
    await assert.rejects(gateway.reopen('bob', completed), /发生变化/);
    assert.equal(await gateway.remove('bob', task.id), undefined);
    assert.equal(await gateway.remove('bob', task.id), 'missing', '404 must remain distinguishable from an acknowledged deletion');
    assert.equal(accounts.bob.size, 0);
    allocatedId = 'server-assigned-id';
    let persistedId;
    await gateway.create('bob', 'client-proposed-id', fields, async id => {
      persistedId = id;
      assert.equal(requests.at(-1).method, 'POST', 'persist receipt before read-back verification');
    });
    assert.equal(persistedId, 'server-assigned-id');
    assert.equal(accounts.bob.has('client-proposed-id'), false);
    assert.equal((await gateway.get('bob', persistedId)).title, fields.title);
    await gateway.remove('bob', persistedId);
    omitReceipt = true; allocatedId = 'unacknowledged-task';
    await assert.rejects(gateway.create('bob', 'missing-receipt', fields), /未返回明确的创建编号/);
    await gateway.remove('bob', allocatedId);
    omitReceipt = false; allocatedId = null; normalizeWrites = true;
    const allDay = taskFields({ title: '全天任务', startDate: '2026-09-11T16:00:00Z', kind: 'CHECKLIST', items: [{ id: 'source-item', title: '核对内容', status: 0, sortOrder: 0 }] });
    await gateway.create('bob', 'normalized-task', allDay);
    const normalized = await gateway.get('bob', 'normalized-task');
    assert.equal(normalized.dueDate, '2026-09-11T16:00:00+0000'); assert.equal(normalized.items[0].id, 'allocated-item-0');
    await gateway.create('bob', 'normalized-task', allDay);
    assert.equal(requests.filter(request => request.body?.add?.some(task => task.id === 'normalized-task')).length, 1);
    await gateway.update('bob', normalized.id, { ...allDay, title: '修改说明后的全天任务' }, remoteVersion(normalized));
    const changed = await gateway.get('bob', normalized.id);
    assert.equal(changed.title, '修改说明后的全天任务'); assert.equal(changed.items[0].id, 'allocated-item-0');
    accounts.bob.get(normalized.id).items[0].title = '其他内容';
    await assert.rejects(gateway.create('bob', normalized.id, { ...allDay, title: changed.title }), /检查项/);
    await assert.rejects(gateway.update('bob', normalized.id, allDay, remoteVersion(changed)), /刚被修改/);
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
    inboxGate = async () => { entered(); await gate; };
    const inboxReads = () => requests.filter(request => request.route.endsWith('/project/inbox/data')).length;
    const beforeReads = inboxReads(), concurrent = Promise.all([gateway.inbox('bob'), gateway.inbox('bob'), gateway.inbox('bob')]);
    await started;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(inboxReads(), beforeReads + 1, 'concurrent display and maintenance share the same account request');
    release(); await concurrent; inboxGate = null;
    await gateway.inbox('bob'); assert.equal(inboxReads(), beforeReads + 2, 'a later explicit refresh still reads new provider data');
    await gateway.inbox('alice');
    assert.ok(requests.some(request => request.owner === 'alice'));
    assert.equal(requests.filter(request => request.route.startsWith('/api/v2/')).length, 0);
    assert.equal(requests.filter(request => request.owner === 'alice' && request.method !== 'GET').length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDir;
    if (previousSecret === undefined) delete process.env.TICKTICK_STORAGE_SECRET; else process.env.TICKTICK_STORAGE_SECRET = previousSecret;
  }
});

test('persisted deletion finishes after restart with an empty inbox whose ID is unavailable', async () => {
  await mkdir('codex-generated/test-data', { recursive: true });
  const dir = await mkdtemp(path.resolve('codex-generated/test-data/deletion-empty-inbox-'));
  const previousDir = process.env.DATA_DIR, previousSecret = process.env.TICKTICK_STORAGE_SECRET, originalFetch = globalThis.fetch;
  process.env.DATA_DIR = dir; process.env.TICKTICK_STORAGE_SECRET = 'synthetic-test-key';
  try {
    const members = [{ id: 'alice', name: 'Alice', connected: true }, { id: 'bob', name: 'Bob', connected: true }];
    const tasks = new Map();
    const seed = new CollaborationStore(dir, {
      members: async () => members,
      inbox: async owner => ({ projectId: `inbox-${owner}`, tasks: owner === 'bob' ? [...tasks.values()] : [] }),
      get: async (owner, id) => tasks.get(id) || null,
      create: async (owner, id, fields) => { tasks.set(id, { id, projectId: `inbox-${owner}`, ...fields }); },
      remove: async (owner, id) => { tasks.delete(id); throw new Error('delete response lost'); },
    });
    await seed.execute('alice', { id: randomUUID(), action: 'create', fields: { title: '删除后收集箱为空' } });
    const card = (await seed.snapshot('alice')).buffer[0];
    let workflow = await seed.claim('bob', { id: randomUUID(), action: 'claim', source: { ownerId: null, taskId: card.id, version: card.version } });
    workflow = await seed.workflowCommand('alice', { id: randomUUID(), workflowId: workflow.id, version: workflow.version, action: 'delete-owner-task' });
    assert.equal(workflow.ownerDeletePending, true); assert.equal(tasks.size, 0);
    await writeFile(path.join(dir, 'identities.json'), JSON.stringify({ version: 1, users: { alice: { nickname: 'Alice', ticktickToken: encryptToken('token-alice') }, bob: { nickname: 'Bob', ticktickToken: encryptToken('token-bob') } } }));
    const output = path.join(dir, 'provider.mjs');
    await build({ entryPoints: ['app/api/room/tasks/provider.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output, logLevel: 'silent' });
    const { gateway } = await import(pathToFileURL(output).href);
    const requests = [];
    let taskExists = false, detailFailure = false;
    globalThis.fetch = async (url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer token-bob');
      const route = new URL(url).pathname.replace('/open/v1', '');
      requests.push({ route, method: init.method || 'GET' });
      if (route === '/project/inbox/data') return Response.json({ tasks: [], columns: [] });
      if (route === '/project/inbox') return new Response(null, { status: 404 });
      if (route === `/project/inbox-bob/task/${workflow.targetId}`) {
        if (detailFailure) return new Response(null, { status: 503 });
        if (init.method === 'DELETE') { taskExists = false; return new Response(null, { status: 204 }); }
        return taskExists ? Response.json({ id: workflow.targetId, projectId: 'inbox-bob', title: workflow.title }) : new Response(null, { status: 404 });
      }
      if (route === '/task/filter' || route === '/task/completed') return Response.json([]);
      throw new Error(`Unexpected request: ${route}`);
    };
    const restarted = new CollaborationStore(dir, { ...gateway, members: async () => members });
    await restarted.recoverPendingWorkflows();
    const saved = (await restarted.snapshot('alice', null)).workflows.find(item => item.id === workflow.id);
    assert.equal(saved.status, 'deleted', saved.error);
    assert.equal(saved.ownerDeletePending, false);
    assert.equal(requests.filter(item => item.method === 'DELETE').length, 0, 'confirmed absence does not repeat deletion');
    taskExists = true;
    await gateway.remove('bob', workflow.targetId, 'inbox-bob');
    assert.equal(await gateway.get('bob', workflow.targetId, 'inbox-bob'), null);
    detailFailure = true;
    await assert.rejects(gateway.get('bob', workflow.targetId, 'inbox-bob'), { status: 502 });
    detailFailure = false;
    await assert.rejects(gateway.create('bob', 'new-task', taskFields({ title: '不得猜测收集箱编号' })), { status: 422 });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDir;
    if (previousSecret === undefined) delete process.env.TICKTICK_STORAGE_SECRET; else process.env.TICKTICK_STORAGE_SECRET = previousSecret;
  }
});

test('workflow lookup repairs exact moved IDs, bounds account searches and rejects malformed or failed responses', async () => {
  await mkdir('codex-generated/test-data', { recursive: true });
  const dir = await mkdtemp(path.resolve('codex-generated/test-data/workflow-provider-'));
  const previousDir = process.env.DATA_DIR, previousSecret = process.env.TICKTICK_STORAGE_SECRET, originalFetch = globalThis.fetch;
  process.env.DATA_DIR = dir; process.env.TICKTICK_STORAGE_SECRET = 'synthetic-test-key';
  try {
    await writeFile(path.join(dir, 'identities.json'), JSON.stringify({ version: 1, users: { alice: { nickname: 'Alice', ticktickToken: encryptToken('token-alice') } } }));
    const output = path.join(dir, 'provider.mjs');
    await build({ entryPoints: ['app/api/room/tasks/provider.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output, logLevel: 'silent' });
    const { gateway } = await import(pathToFileURL(output).href);
    let searchCount = 0, failure = null, removed = false, task = { id: 'moved', projectId: 'other-list', status: 0, ...taskFields({ title: 'original' }) };
    globalThis.fetch = async (url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer token-alice');
      const route = new URL(url).pathname.replace('/open/v1', '');
      if (route === '/project/inbox/data') return Response.json({ project: { id: 'inbox-alice' }, tasks: [], columns: [] });
      if (route === '/task/filter') { searchCount++; if (failure) return failure(); return Response.json([task, ...Array.from({ length: 199 }, (_, index) => ({ id: `other-${index}`, projectId: 'other-list', status: 0 }))]); }
      if (route === '/project') return Response.json([{ id: 'other-list' }, { id: 'outside-filter' }]);
      if (route === '/task/completed') return Response.json([{ id: 'history-only', projectId: 'inbox-alice', status: 2, title: '历史完成' }]);
      if (route === '/project/outside-filter/task/older-moved') return Response.json({ ...task, id: 'older-moved', projectId: 'outside-filter' });
      if (route === '/project/other-list/task/moved/complete') { task.status = 2; return new Response(null, { status: 204 }); }
      if (route === '/project/other-list/task/moved') {
        if (init.method === 'DELETE') { removed = true; return new Response(null, { status: 204 }); }
        return removed ? new Response(null, { status: 404 }) : Response.json(task);
      }
      if (route === '/task/moved') { task = { ...task, ...JSON.parse(init.body) }; return Response.json(task); }
      return new Response(null, { status: 404 });
    };
    assert.equal(await gateway.get('alice', 'moved'), null, 'ordinary lookup retains inbox scope');
    assert.equal((await gateway.locate('alice', 'moved')).projectId, 'other-list');
    assert.equal(await gateway.locate('alice', 'absent'), null); assert.equal(searchCount, 1);
    assert.equal((await gateway.locate('alice', 'history-only')).status, 2);
    assert.equal((await gateway.locate('alice', 'older-moved')).projectId, 'outside-filter', 'project enumeration finds moves outside capped filter results');
    await gateway.update('alice', 'moved', taskFields({ title: 'updated' }), remoteVersion(task), 'other-list');
    assert.equal(task.title, 'updated'); assert.equal(task.projectId, 'other-list');
    await gateway.complete('alice', 'moved', 'other-list'); assert.equal(task.status, 2);
    await gateway.remove('alice', 'moved', 'other-list'); assert.ok(removed);
    assert.equal(await gateway.get('alice', 'moved', 'other-list'), null);
    await assert.rejects(gateway.remove('alice', 'moved', '../foreign'), { status: 400 });
    for (const result of [() => new Response(null, { status: 401 }), () => new Response(null, { status: 429 }), () => new Response(null, { status: 500 }), () => new Response('broken-json'), () => Response.json({ tasks: [] })]) {
      failure = result; await gateway.inbox('alice');
      await assert.rejects(gateway.locate('alice', 'absent'));
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDir;
    if (previousSecret === undefined) delete process.env.TICKTICK_STORAGE_SECRET; else process.env.TICKTICK_STORAGE_SECRET = previousSecret;
  }
});

test('lookup searches open tasks first, limits completion history to publication and 200 records, and preserves unknown results', async () => {
  await mkdir('codex-generated/test-data', { recursive: true });
  const dir = await mkdtemp(path.resolve('codex-generated/test-data/workflow-search-'));
  const previousDir = process.env.DATA_DIR, previousSecret = process.env.TICKTICK_STORAGE_SECRET, originalFetch = globalThis.fetch;
  process.env.DATA_DIR = dir; process.env.TICKTICK_STORAGE_SECRET = 'synthetic-test-key';
  try {
    await writeFile(path.join(dir, 'identities.json'), JSON.stringify({ version: 1, users: { alice: { nickname: 'Alice', ticktickToken: encryptToken('token-alice') } } }));
    const output = path.join(dir, 'provider.mjs');
    await build({ entryPoints: ['app/api/room/tasks/provider.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output, logLevel: 'silent' });
    const { gateway } = await import(pathToFileURL(output).href);
    const base = Date.now() - 100000;
    const history = Array.from({ length: 401 }, (_, index) => ({ id: `history-${index}`, projectId: 'inbox-alice', title: '完成记录', status: 2, completedTime: new Date(base + index * 100).toISOString() }));
    let requests = [], ignoreRange = false, failHistory = false, reopened = null;
    globalThis.fetch = async (url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer token-alice');
      const route = new URL(url).pathname.replace('/open/v1', ''), body = init.body ? JSON.parse(init.body) : null;
      requests.push({ route, body });
      if (route === '/project/inbox/data') return Response.json({ project: { id: 'inbox-alice' }, tasks: [] });
      if (route === '/project/inbox-alice/task/history-400' && reopened) return Response.json(reopened);
      if (route === '/task/batch') { reopened = body.update[0]; return Response.json({ id2etag: { [reopened.id]: 'restored' } }); }
      if (route === '/task/filter') { assert.deepEqual(body.status, [0]); return Response.json([{ id: 'moved', projectId: 'other', title: '当前未完成', status: 0 }]); }
      if (route === '/project') return Response.json([{ id: 'other' }]);
      if (route === '/project/inbox-alice/task/moved') return Response.json({ id: 'moved', projectId: 'inbox-alice', title: '历史完成', status: 2 });
      if (route === '/project/other/task/moved') return Response.json({ id: 'moved', projectId: 'other', title: '当前未完成', status: 0 });
      if (route === '/task/completed') {
        if (failHistory) return new Response(null, { status: 503 });
        return Response.json(history.filter(task => ignoreRange || ((!body.startDate || Date.parse(task.completedTime) >= Date.parse(body.startDate)) && (!body.endDate || Date.parse(task.completedTime) <= Date.parse(body.endDate)))).slice(0, 200));
      }
      return new Response(null, { status: 404 });
    };
    const open = await gateway.locate('alice', 'moved'); assert.equal(open.status, 0); assert.equal(open.projectId, 'other');
    assert.ok(!requests.some(item => item.route === '/task/completed'), 'open exact ID wins over a completed candidate');
    requests = [];
    const publication = base + 30000;
    const old = await gateway.locate('alice', 'history-400', undefined, publication); assert.equal(old.id, 'history-400'); assert.equal(old.status, 2);
    assert.deepEqual(requests.filter(item => item.route === '/task/completed').map(item => item.body), [{ startDate: new Date(publication).toISOString() }]);
    assert.equal((await gateway.locate('alice', 'history-300', undefined, publication)).id, 'history-300', 'publication boundary is inclusive');
    assert.equal(await gateway.locate('alice', 'history-299', undefined, publication), null, 'never searches records earlier than publication');
    assert.equal(await gateway.locate('alice', 'deleted', undefined, publication), null);
    assert.equal(requests.filter(item => item.route === '/task/completed').length, 1, 'same account and boundary share one completed read');
    const firstCompleted = requests.findIndex(item => item.route === '/task/completed');
    assert.ok(firstCompleted >= 0);
    assert.ok(!requests.some(item => item.route === '/project'), 'an uncapped unfinished search must not enumerate every project');
    const restored = await gateway.reopen('alice', old, publication);
    assert.equal(restored.status, 0);
    assert.equal(requests.filter(item => item.route === '/task/completed').length, 1, 'reopen fallback retains publication boundary and cached exact-ID evidence');
    await gateway.inbox('alice'); requests = [];
    await assert.rejects(gateway.locate('alice', 'history-300', undefined, base), error => error.status === 502);
    assert.equal(requests.filter(item => item.route === '/task/completed').length, 1, 'an old publication still permits at most 200 records, without pagination');
    assert.equal((await gateway.locate('alice', 'history-199', undefined, base)).id, 'history-199', 'exact match within a capped page remains usable');
    await assert.rejects(gateway.locate('alice', 'deleted', undefined, base), error => error.status === 502);
    for (const failure of ['ignored-range', 'unavailable']) {
      await gateway.inbox('alice'); ignoreRange = failure === 'ignored-range'; failHistory = failure === 'unavailable';
      await assert.rejects(gateway.locate('alice', 'deleted', undefined, publication), error => error.status === 502);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDir;
    if (previousSecret === undefined) delete process.env.TICKTICK_STORAGE_SECRET; else process.env.TICKTICK_STORAGE_SECRET = previousSecret;
  }
});
