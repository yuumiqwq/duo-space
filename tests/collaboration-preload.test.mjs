import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadCollaborationSnapshot, mergeCollaborationSnapshot } from '../app/collaboration-loading.ts';
import { withoutDeletedWorkflowTasks } from '../app/collaboration-snapshot.ts';
import { splitCollaborationTasks } from '../app/collaboration-view.ts';
import { showCollaborationDialog } from '../app/collaboration-dialog.ts';
import { taskboardAttentionCount, workflowAttentionCount } from '../app/workflow-execution.ts';

// Execute the component's actual request callback and effects without adding a
// browser runtime to the test suite. DOM focus and timers are controlled here.
const source = ts.createSourceFile('RoomCollaboration.tsx', readFileSync(new URL('../app/RoomCollaboration.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'RoomCollaboration');
const load = component.body.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(source) === 'load'));
const effects = component.body.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'useEffect')
  .filter(node => { const deps = node.expression.arguments[1]?.elements?.map(item => item.getText(source)) || []; return deps.includes('load') && !deps.includes('onChanged'); });
assert.equal(effects.length, 2);
const transpile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('classroom preload survives board close and reopen, shares pending reads, and stops updates on unmount', async () => {
  const alice = deferred(), bob = deferred(), scheduled = new Map(), intervals = new Map(), hooks = [], requests = [];
  const snapshot = { identityId: 'alice', revision: 1, buffer: [], workflows: [], operations: [], members: ['alice', 'bob'].map(id => ({ id, name: id, connected: true, loading: true, tasks: [] })) };
  let current = null, sequence = 0, loading = false;
  const request = async (url, init) => {
    requests.push({ url, signal: init.signal });
    if (url.endsWith('local=1')) return Response.json(snapshot);
    const id = url.endsWith('alice') ? 'alice' : 'bob';
    await (id === 'alice' ? alice : bob).promise;
    return Response.json({ ...snapshot, members: [{ ...snapshot.members.find(item => item.id === id), loading: false, tasks: [{ id: id + '-task' }] }] });
  };
  const fixture = {
    useCallback: fn => fn, useEffect: fn => hooks.push(fn), previewSnapshot: undefined, identityId: 'alice', open: false,
    remoteVersions: { current: null }, fetching: { current: false }, generation: { current: 0 }, loadController: { current: null }, revision: { current: null },
    setLoading: value => { loading = value; }, setError: error => assert.fail(error), acceptNotices() {},
    setSnapshot: update => { current = update(current); }, mergeCollaborationSnapshot, withoutDeletedWorkflowTasks,
    loadCollaborationSnapshot: options => loadCollaborationSnapshot({ ...options, request }), taskErrorMessage: error => String(error),
    showCollaborationDialog, dialog: { current: { showModal() {}, close() {} } }, trigger: { current: { focus() {} } },
    document: { hidden: false }, locked: { current: false }, drag: { current: null },
    setTimeout: fn => { const id = ++sequence; scheduled.set(id, fn); return id; }, clearTimeout: id => scheduled.delete(id),
    setInterval: fn => { const id = ++sequence; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
  };
  const api = new Function(...Object.keys(fixture), transpile(`${load.getText(source)}\n${effects.map(node => node.getText(source)).join('\n')}\nreturn { load, setOpen: value => { open = value; } };`))(...Object.values(fixture));
  const flush = async () => { for (const [id, fn] of [...scheduled]) { scheduled.delete(id); fn(); } await tick(); };
  const unmount = hooks[0]();
  assert.equal(hooks[1](), undefined, 'closed board does not start a second read');
  await flush(); assert.equal(requests.length, 3); assert.ok(loading);
  api.setOpen(true); const close = hooks[1](); await flush();
  assert.equal(requests.length, 3, 'opening reuses pending preload');
  close(); assert.ok(requests.every(item => !item.signal.aborted)); assert.equal(intervals.size, 0);
  const closeAgain = hooks[1](); await flush(); assert.equal(requests.length, 3, 'reopening also reuses the same reads');
  await api.load(true, []);
  assert.equal(requests.length, 4, 'a website command only refreshes local records');
  assert.ok(requests.slice(0, 3).every(item => !item.signal.aborted), 'local commands preserve the existing preload');
  alice.resolve(); await tick();
  assert.equal(current.members[0].tasks[0].id, 'alice-task'); assert.ok(current.members[1].loading);
  closeAgain(); unmount();
  const before = structuredClone(current); bob.resolve(); await tick();
  assert.deepEqual(current, before, 'late completion after leaving the room cannot change the snapshot');
  assert.ok(requests.slice(0, 3).every(item => item.signal.aborted));
});

test('member column renders preloaded tasks alongside a refresh error instead of hiding the list', () => {
  const column = component.body.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'column');
  const fixture = { React, splitCollaborationTasks, hoverOwner: null, identityId: 'bob', card: task => React.createElement('article', { key: task.id }, task.title) };
  const render = new Function(...Object.keys(fixture), transpile(`${column.getText(source)}\nreturn column;`))(...Object.values(fixture));
  const html = renderToStaticMarkup(render('alice', 'Alice', [{ id: 'cached', title: '上次成功读取的任务' }], '收集箱暂时无法读取'));
  assert.ok(html.includes('上次成功读取的任务')); assert.ok(html.includes('收集箱暂时无法读取'));
  assert.ok(!html.includes('正在读取…')); assert.ok(html.includes('coop-member-lanes'));
});

test('closed taskboard polls update review badges without inbox reloads and stale summaries cannot replace newer state', async () => {
  const pollEffect = component.body.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'useEffect' && node.expression.arguments[1]?.elements?.some(item => item.getText(source) === 'onChanged'));
  const badgeDeclarations = component.body.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => ['badgeWorkflows', 'unseenCount', 'workflowCount'].includes(item.name.getText(source))));
  const counts = new Function('attention', 'snapshot', 'taskNotices', 'taskboardAttentionCount', 'workflowAttentionCount', transpile(`const identityId = 'alice';\n${badgeDeclarations.map(node => node.getText(source)).join('\n')}\nreturn { main: unseenCount, workflow: workflowCount };`));
  let attention = null, notices = [], snapshot = { revision: 1, workflows: [] }, interval, first, cleanup;
  const submitted = { id: 'review', status: 'submitted', executing: true, source: { ownerId: null, taskId: 'shared' } };
  let response = { revision: 2, attentionWorkflows: [submitted], notices: [], remoteVersions: { bob: 'unchanged' } };
  const requests = [], revision = { current: 1 };
  const events = { addEventListener() {}, removeEventListener() {} };
  const fixture = {
    useEffect: fn => { cleanup = fn(); }, identityId: 'alice', previewSnapshot: undefined, open: false,
    document: { ...events, hidden: false }, window: events, locked: { current: false }, generation: { current: 0 }, revision,
    remoteVersions: { current: { bob: 'unchanged' } }, fetching: { current: false },
    acceptNotices: incoming => { notices = incoming; }, setAttention: update => { attention = update(attention); },
    onPublicTasks() {}, load: () => assert.fail('local review changes do not reload inboxes'), onChanged: () => assert.fail('no external tasks changed'),
    setSnapshot: () => assert.fail('closed polls retain the full snapshot'), mergeCollaborationSnapshot,
    fetch: async url => { requests.push(url); return Response.json(response); },
    setTimeout: fn => { first = fn; return 1; }, clearTimeout() {},
    setInterval: (fn, delay) => { interval = fn; assert.equal(delay, 5000); return 2; }, clearInterval() {},
  };
  new Function(...Object.keys(fixture), transpile(pollEffect.getText(source)))(...Object.values(fixture));
  const currentCounts = () => counts(attention, snapshot, notices, taskboardAttentionCount, workflowAttentionCount);
  try {
    first(); await tick();
    assert.deepEqual(currentCounts(), { main: 1, workflow: 1 });
    assert.deepEqual(counts(attention, null, notices, taskboardAttentionCount, workflowAttentionCount), { main: 1, workflow: 1 }, 'first lightweight response can show reviews before preload completes');
    response = { ...response, revision: 1, attentionWorkflows: [] }; interval(); await tick();
    assert.equal(attention.revision, 2); assert.deepEqual(currentCounts(), { main: 1, workflow: 1 });
    snapshot = { revision: 4, workflows: [{ ...submitted, status: 'done' }] }; revision.current = 4;
    assert.deepEqual(currentCounts(), { main: 0, workflow: 0 }, 'a newer successful command takes effect immediately');
    response = { ...response, revision: 3, attentionWorkflows: [submitted] }; interval(); await tick();
    assert.deepEqual(currentCounts(), { main: 0, workflow: 0 });
    response = { ...response, revision: 5, attentionWorkflows: [], notices: [{ kind: 'public', taskId: 'new' }] }; interval(); await tick();
    assert.deepEqual(currentCounts(), { main: 1, workflow: 0 });
    notices = []; assert.deepEqual(currentCounts(), { main: 0, workflow: 0 }, 'read acknowledgement updates the count without a new summary');
    response = { ...response, revision: 6, attentionWorkflows: [{ ...submitted, claimantId: 'alice', status: 'working', executing: false }], notices: [{ id: 'other-edit', kind: 'workflow', workflowId: 'review', eventType: 'updated', actorId: 'bob' }] };
    interval(); await tick(); assert.deepEqual(currentCounts(), { main: 1, workflow: 0 }, 'an unarranged claimant edit appears without opening the board');
    notices = []; assert.deepEqual(currentCounts(), { main: 0, workflow: 0 }, 'detail acknowledgement clears the claimant count');
    assert.ok(requests.every(url => url === '/api/room/tasks?revision=1'));
  } finally { cleanup(); }
});
