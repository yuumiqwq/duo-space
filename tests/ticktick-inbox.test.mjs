import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { tickInboxData, resolveTickInbox } from '../app/api/ticktick/client.ts';

test('reported 24-task response without project metadata resolves its unique account-specific inbox and retains every task', async () => {
  const original = globalThis.fetch;
  const tasks = Array.from({ length: 24 }, (_, index) => ({ id: `task-${index}`, projectId: 'reported-account-inbox', title: `任务 ${index}`, content: '保留原有内容', priority: 3 }));
  const data = { tasks, columns: [] };
  globalThis.fetch = async url => { assert.ok(url.endsWith('/project/inbox/data')); return Response.json(data); };
  try {
    const inbox = await tickInboxData('reported-shape-token');
    assert.equal(inbox.projectId, 'reported-account-inbox');
    assert.deepEqual(inbox.tasks, tasks);
    data.tasks = [];
    assert.deepEqual(await tickInboxData('reported-shape-token'), { projectId: 'reported-account-inbox', tasks: [] });
  } finally { globalThis.fetch = original; }
});

test('unseen empty inboxes display immediately and resolve optional metadata only for writes and never reuse another account ID when metadata is unavailable', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/project/inbox/data')) return Response.json({ tasks: [], columns: [] });
    assert.ok(url.endsWith('/project/inbox'));
    return init.headers.Authorization === 'Bearer empty-metadata-token' ? Response.json({ id: 'empty-metadata-inbox' }) : new Response(null, { status: 404 });
  };
  try {
    const inbox = await tickInboxData('empty-metadata-token');
    assert.deepEqual(inbox, { projectId: 'inbox', tasks: [] });
    assert.deepEqual(await resolveTickInbox('empty-metadata-token', inbox), { projectId: 'empty-metadata-inbox', tasks: [] });
    assert.deepEqual(await tickInboxData('different-empty-token'), { projectId: 'inbox', tasks: [] });
  } finally { globalThis.fetch = original; }
});

test('official inbox lookup handles empty accounts and never guesses an ID from another task or environment', async () => {
  const originalFetch = globalThis.fetch, previous = process.env.TICKTICK_INBOX_ID;
  process.env.TICKTICK_INBOX_ID = 'foreign-inbox';
  let data = { project: { id: 'account-inbox' }, tasks: [] }, status = 200;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.dida365.com/open/v1/project/inbox/data');
    assert.equal(init.headers.Authorization, 'Bearer open-api-only');
    assert.equal(init.headers.Cookie, undefined);
    return Response.json(data, { status });
  };
  try {
    assert.deepEqual(await tickInboxData('open-api-only'), { projectId: 'account-inbox', tasks: [] });
    data.tasks = [{ id: 'valid', projectId: 'account-inbox' }, { id: 'foreign', projectId: 'foreign-inbox' }, null];
    assert.deepEqual((await tickInboxData('open-api-only')).tasks.map(task => task.id), ['valid']);
    delete data.project;
    await assert.rejects(tickInboxData('open-api-only'), error => error.message.includes('查看连接诊断') && JSON.parse(error.diagnostic).shape.project.id === 'undefined');
    for (const code of [401, 403, 429, 500]) {
      status = code;
      await assert.rejects(tickInboxData('open-api-only'), error => error.status === code && (code === 401 ? error.message.includes('重新连接') : !error.message.includes('重新连接')));
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.TICKTICK_INBOX_ID; else process.env.TICKTICK_INBOX_ID = previous;
  }
});

test('task board reads normal projects and the official inbox without V2 and reports temporary inbox errors separately', async () => {
  await mkdir('codex-generated/test-data', { recursive: true });
  const dir = await mkdtemp(path.resolve('codex-generated/test-data/inbox-route-'));
  const output = path.join(dir, 'route.mjs'), require = createRequire(import.meta.url);
  await build({ entryPoints: ['app/api/ticktick/tasks/route.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output, logLevel: 'silent', plugins: [{ name: 'test-identity', setup(build) {
    build.onResolve({ filter: /^next\/server$/ }, () => ({ path: pathToFileURL(require.resolve('next/server')).href, external: true }));
    build.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: 'test-identity', namespace: 'identity' }));
    build.onLoad({ filter: /.*/, namespace: 'identity' }, () => ({ contents: 'export async function accessToken() { return "board-token"; }' }));
  } }] });
  const { GET } = await import(pathToFileURL(output).href);
  const originalFetch = globalThis.fetch, calls = [];
  let inboxStatus = 200;
  globalThis.fetch = async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer board-token'); calls.push(url);
    if (url.endsWith('/api/v2/batch/check/0')) return new Response(null, { status: 401 });
    if (url.endsWith('/project')) return Response.json([{ id: 'study', name: '学习' }]);
    if (url.endsWith('/project/study/data')) return Response.json({ tasks: [{ id: 'study-task', projectId: 'study', title: '清单任务' }] });
    if (url.endsWith('/project/inbox/data')) return Response.json({ tasks: [{ id: 'inbox-task', projectId: 'board-inbox', title: '收集箱任务' }], columns: [] }, { status: inboxStatus });
    assert.fail(`unexpected request: ${url}`);
  };
  try {
    const response = await GET(new Request('http://localhost/api/ticktick/tasks?view=undated'));
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.deepEqual(snapshot.tasks.map(task => task.id).sort(), ['inbox-task', 'study-task']);
    assert.equal(snapshot.projects.find(project => project.id === 'board-inbox').name, '收集箱');
    assert.equal(snapshot.inboxError, undefined);
    assert.equal(calls.filter(url => url.includes('/api/v2/')).length, 0);
    assert.equal(calls.filter(url => url.endsWith('/project/inbox/data')).length, 1);
    inboxStatus = 503;
    const partial = await GET(new Request('http://localhost/api/ticktick/tasks?view=undated'));
    assert.equal(partial.status, 200);
    const partialSnapshot = await partial.json();
    assert.equal(partialSnapshot.tasks.length, 1);
    assert.match(partialSnapshot.inboxError, /稍后刷新/);
    assert.ok(!partialSnapshot.inboxError.includes('重新连接'));
  } finally { globalThis.fetch = originalFetch; }
});
