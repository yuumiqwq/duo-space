import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { taskDateInputs, taskDateSelection } from '../app/task-date-input.ts';
import { rebaseWorkflowDraft } from '../app/workflow-draft.ts';
import { taskFields } from '../app/api/room/tasks/store.ts';

function editor(currentFields) {
  const source = ts.createSourceFile('WorkflowSettings.tsx', readFileSync(new URL('../app/WorkflowSettings.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'TaskSettings');
  const code = ts.transpileModule(component.getText(source).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const state = [], saved = []; let cursor = 0;
  const CalendarField = () => {}, TaskDescriptionEditor = () => {}, Choices = () => {};
  const render = new Function('useState', 'React', 'taskDateInputs', 'taskDateSelection', 'rebaseWorkflowDraft', 'CalendarField', 'TaskDescriptionEditor', 'Choices', `${code}; return TaskSettings;`)(
    initial => { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], next => { state[index] = next; }]; },
    { createElement: (type, props, ...children) => ({ type, props, children }) }, taskDateInputs, taskDateSelection, rebaseWorkflowDraft, CalendarField, TaskDescriptionEditor, Choices);
  const tree = () => { cursor = 0; return render({ taskKey: 'task', currentFields, disabled: false, save: async fields => { saved.push(fields); return true; }, deletion: () => null }); };
  const nodes = value => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.children)];
  const calendar = label => nodes(tree()).find(node => node.type === CalendarField && node.props.label === label);
  return { saved, calendar, tree, input: type => nodes(tree()).find(node => node.type === 'input' && node.props?.type === type) };
}

test('task settings show one day, move both stored dates together and clear the full schedule', () => {
  const date = '2026-09-12T16:00:00.000Z';
  for (const selection of ['2026-09-15', '']) {
    const view = editor(taskFields({ title: 'single day', startDate: date, dueDate: date }));
    assert.equal(view.calendar('开始时间').props.value, '2026-09-13'); assert.equal(view.calendar('结束时间').props.value, '');
    view.calendar('开始时间').props.change(selection); view.tree().props.onSubmit({ preventDefault() {} });
    assert.equal(view.saved.length, 1);
    assert.deepEqual(view.saved[0], selection ? { startDate: '2026-09-15T00:00:00+0800', dueDate: '2026-09-15T00:00:00+0800' } : { startDate: null, dueDate: null });
  }
});

test('task settings preserve untouched dates and support date ranges and all-day toggling', () => {
  const date = '2026-09-12T16:00:00.000Z';
  const title = editor(taskFields({ title: 'old', startDate: date }));
  title.input(undefined).props.onChange({ target: { value: 'new' } }); title.tree().props.onSubmit({ preventDefault() {} });
  assert.deepEqual(title.saved[0], { title: 'new' });
  const range = editor(taskFields({ title: 'range', startDate: date, dueDate: date }));
  range.calendar('结束时间').props.change('2026-09-15'); range.tree().props.onSubmit({ preventDefault() {} });
  assert.deepEqual(range.saved[0], { dueDate: '2026-09-15T23:59:00+0800' });
  const timed = editor(taskFields({ title: 'timed', startDate: date, dueDate: date }));
  timed.input('checkbox').props.onChange({ target: { checked: false } }); timed.tree().props.onSubmit({ preventDefault() {} });
  assert.deepEqual(timed.saved[0], { startDate: '2026-09-13T09:00:00+0800', dueDate: null, isAllDay: false });
  const allDay = editor(taskFields({ title: 'all day', startDate: '2026-09-13T09:00:00+0800', isAllDay: false }));
  allDay.input('checkbox').props.onChange({ target: { checked: true } }); allDay.tree().props.onSubmit({ preventDefault() {} });
  assert.deepEqual(allDay.saved[0], { startDate: '2026-09-13T00:00:00+0800', dueDate: '2026-09-13T00:00:00+0800', isAllDay: true });
});
