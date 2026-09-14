import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('website resync requires a second click for the same task and version', () => {
  const source = ts.createSourceFile('WorkflowResyncSettings.tsx', readFileSync(new URL('../app/WorkflowResyncSettings.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'WorkflowResyncSettings');
  const code = ts.transpileModule(component.getText(source).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  let armed = null; const calls = [];
  const render = new Function('useState', 'React', `${code}; return WorkflowResyncSettings;`)(
    () => [armed, next => { armed = next; }],
    { createElement: (type, props, ...children) => ({ type, props, children }) },
  );
  const workflow = { id: 'first', version: 8 };
  const button = (disabled = false) => render({ workflow, disabled, perform: command => { calls.push(command); return Promise.resolve(true); } }).children[0];
  assert.equal(button().children[0], '以网站设置同步');
  button().props.onClick(); assert.equal(calls.length, 0);
  assert.equal(button().children[0], '确认以网站设置覆盖滴答');
  workflow.version++;
  assert.equal(button().children[0], '以网站设置同步');
  button().props.onClick(); workflow.id = 'second';
  assert.equal(button().children[0], '以网站设置同步');
  button().props.onClick(); assert.equal(calls.length, 0);
  assert.equal(button(true).props.disabled, true);
  button().props.onClick(); assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'resync-settings'); assert.equal(calls[0].workflowId, 'second'); assert.equal(calls[0].version, 9);
  assert.equal(button().children[0], '以网站设置同步');
});
