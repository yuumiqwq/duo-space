import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadCollaborationSnapshot, mergeCollaborationSnapshot } from '../app/collaboration-loading.ts';
import { withoutDeletedWorkflowTasks } from '../app/collaboration-snapshot.ts';
import { splitCollaborationTasks } from '../app/collaboration-view.ts';

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
    fetching: { current: false }, generation: { current: 0 }, loadController: { current: null }, revision: { current: null },
    setLoading: value => { loading = value; }, setError: error => assert.fail(error), acceptNotices() {},
    setSnapshot: update => { current = update(current); }, mergeCollaborationSnapshot, withoutDeletedWorkflowTasks,
    loadCollaborationSnapshot: options => loadCollaborationSnapshot({ ...options, request }), taskErrorMessage: error => String(error),
    dialog: { current: { showModal() {}, close() {} } }, trigger: { current: { focus() {} } },
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
  alice.resolve(); await tick();
  assert.equal(current.members[0].tasks[0].id, 'alice-task'); assert.ok(current.members[1].loading);
  closeAgain(); unmount();
  const before = structuredClone(current); bob.resolve(); await tick();
  assert.deepEqual(current, before, 'late completion after leaving the room cannot change the snapshot');
  assert.ok(requests.every(item => item.signal.aborted));
});

test('member column renders preloaded tasks alongside a refresh error instead of hiding the list', () => {
  const column = component.body.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'column');
  const fixture = { React, splitCollaborationTasks, hoverOwner: null, identityId: 'bob', card: task => React.createElement('article', { key: task.id }, task.title) };
  const render = new Function(...Object.keys(fixture), transpile(`${column.getText(source)}\nreturn column;`))(...Object.values(fixture));
  const html = renderToStaticMarkup(render('alice', 'Alice', [{ id: 'cached', title: '上次成功读取的任务' }], '收集箱暂时无法读取'));
  assert.ok(html.includes('上次成功读取的任务')); assert.ok(html.includes('收集箱暂时无法读取'));
  assert.ok(!html.includes('正在读取…')); assert.ok(html.includes('coop-member-lanes'));
});
