import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { readTaskResponse, taskErrorMessage } from '../app/task-request.ts';

const source = ts.createSourceFile('WorkflowSyncReport.tsx', readFileSync(new URL('../app/WorkflowSyncReport.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'WorkflowSyncReport');
const callback = component.body.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'copyReport');
const code = ts.transpileModule(callback.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture(data, clipboardFails = false) {
  const state = {}, copied = [], requests = [], locked = { current: false };
  const variables = {
    workflowId: 'selected', disabled: false, locked, AbortSignal, readTaskResponse, taskErrorMessage,
    setBusy: value => { state.busy = value; }, setCopied: value => { state.copied = value; },
    setError: value => { state.error = value; }, setReport: value => { state.report = value; },
    output: { current: { focus() { state.focused = true; }, select() { state.selected = true; } } },
    requestAnimationFrame: callback => callback(),
    fetch: async (url, options) => { requests.push({ url, options }); return Response.json(data); },
    navigator: { clipboard: { writeText: async value => { if (clipboardFails) throw new Error('denied'); copied.push(value); } } },
  };
  const copy = new Function(...Object.keys(variables), `${code}; return copyReport;`)(...Object.values(variables));
  return { state, copied, requests, locked, copy };
}

test('copy diagnostic uses the selected workflow and falls back to selectable text when clipboard is unavailable', async () => {
  const data = { workflowId: 'selected', error: '写入失败', attempts: [{ stage: 'write' }] };
  for (const blocked of [false, true]) {
    const f = fixture(data, blocked); await f.copy();
    assert.equal(f.requests[0].url, '/api/room/tasks?workflow-diagnostic=selected');
    assert.equal(f.requests[0].options.cache, 'no-store');
    assert.equal(f.state.busy, false); assert.equal(f.locked.current, false);
    assert.deepEqual(JSON.parse(blocked ? f.state.report : f.copied[0]), data);
    if (blocked) { assert.equal(f.state.focused, true); assert.equal(f.state.selected, true); assert.equal(f.state.copied, false); }
    else assert.equal(f.state.copied, true);
  }
});

test('mismatched reports are never copied and concurrent clicks do not duplicate requests', async () => {
  const f = fixture({ workflowId: 'different', error: 'unrelated task' });
  await Promise.all([f.copy(), f.copy()]);
  assert.equal(f.requests.length, 1); assert.equal(f.copied.length, 0); assert.equal(f.state.report, '');
  assert.equal(f.state.error, '错误报告与任务不符'); assert.equal(f.locked.current, false);
});
