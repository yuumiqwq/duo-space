import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

for (const [componentName, record, key, version, label, action] of [
  ['WorkflowDeletionRetry', { id: 'first', version: 8, status: 'deleted', error: '滴答清单中删除失败', reviewerId: 'alice', claimantId: 'bob' }, 'workflow', 'version', '重试删除滴答副本', 'retry-deletion'],
  ['OperationResyncSettings', { id: 'first', updatedAt: 8, action: 'update', status: 'pending', error: '任务已被修改，请取消此次操作并刷新', from: 'bob', actorId: 'bob' }, 'operation', 'updatedAt', '以网站设置同步', 'resync-operation'],
]) test(`${componentName} confirms the current record and resets confirmation after it changes`, () => {
  const source = ts.createSourceFile(componentName + '.tsx', readFileSync(new URL(`../app/${componentName}.tsx`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === componentName);
  const code = ts.transpileModule(component.getText(source).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  let armed = null; const calls = [];
  const render = new Function('useState', 'React', `${code}; return ${componentName};`)(
    () => [armed, next => { armed = next; }], { createElement: (type, props, ...children) => ({ type, props, children }) });
  const tree = extra => render({ [key]: record, identityId: 'alice', disabled: false, perform: command => { calls.push(command); return Promise.resolve(true); }, ...extra });
  const button = extra => { const result = tree(extra); return result?.type === 'div' ? result.children[0] : result; };
  assert.equal(button().children[0], label); button().props.onClick(); assert.equal(calls.length, 0);
  record[version]++; assert.equal(button().children[0], label); button().props.onClick();
  record.id = 'second'; assert.equal(button().children[0], label);
  button().props.onClick(); assert.equal(button({ disabled: true }).props.disabled, true);
  button().props.onClick(); assert.equal(calls.length, 1); assert.equal(calls[0].action, action);
  assert.equal(calls[0][key === 'workflow' ? 'workflowId' : 'operationId'], 'second');
  if (key === 'workflow') {
    assert.equal(tree({ identityId: 'other' }), null);
    record.deletionPending = true; assert.equal(button().props.disabled, true);
    record.status = 'working'; assert.equal(tree(), null);
  } else { record.status = 'done'; assert.equal(tree(), null); }
});

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
