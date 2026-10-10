import test from 'node:test';
import assert from 'node:assert/strict';
import { taskFields } from '../app/api/room/tasks/store.ts';
import { parseWorkflowSettingChanges, workflowSettingChangeEntries, workflowSettingChanges } from '../app/workflow-setting-changes.ts';
import { attachmentMarkdown, attachmentDisplayText } from '../app/task-description-attachments.ts';

test('setting history shows only changed fields with readable old and new values', () => {
  const before = taskFields({ title: '任务', priority: 0 });
  assert.equal(workflowSettingChanges(before, { ...before, priority: 5 }), '优先级：无 → 高');
  assert.equal(workflowSettingChanges(before, before), '设置未变化');
  const summary = workflowSettingChanges(before, { ...before, repeatFlag: 'RRULE:FREQ=WEEKLY;INTERVAL=1', reminders: ['TRIGGER:-PT15M'], tags: ['学习'] });
  assert.equal(summary, '标签：无 → 学习\n重复：不重复 → 每周\n提醒：不提醒 → 提前15分钟');
  assert.equal(workflowSettingChanges({ ...before, priority: 5 }, before), '优先级：高 → 无');
});

test('new and historical attachment changes show filenames with extensions instead of raw URLs', () => {
  const old = attachmentMarkdown('https://study.11scat.xyz', 'old.png', 'tasks/a/b/old.png');
  const next = attachmentMarkdown('https://study.11scat.xyz', 'input.txt', 'tasks/a/c/input.txt');
  assert.equal(workflowSettingChanges(taskFields({ content: old }), taskFields({ content: next })), '说明：[图1.png] → [input.txt]');
  assert.equal(attachmentDisplayText(`说明：无 → ${old}`), '说明：无 → [图1.png]');
});

test('card values preserve paragraph breaks and arrows while legacy summaries retain their format', () => {
  const before = taskFields({ content: '前文 → 后文\n\n优先级：这行属于说明' });
  const after = { ...before, content: '第一段\n第二段 → 第三段', priority: 5 };
  assert.deepEqual(workflowSettingChangeEntries(before, after), [
    { field: 'content', label: '说明', before: before.content, after: after.content },
    { field: 'priority', label: '优先级', before: '无', after: '高' },
  ]);
  assert.equal(workflowSettingChanges(before, after), '说明：前文 → 后文 优先级：这行属于说明 → 第一段 第二段 → 第三段\n优先级：无 → 高');
  const ordinary = { ...before, content: '新说明', tags: ['学习'], repeatFlag: 'RRULE:FREQ=WEEKLY;INTERVAL=1', reminders: ['TRIGGER:-PT15M'] };
  const empty = taskFields({});
  assert.deepEqual(parseWorkflowSettingChanges(workflowSettingChanges(empty, ordinary)), workflowSettingChangeEntries(empty, ordinary));
  assert.equal(parseWorkflowSettingChanges('设置未变化'), null);
  assert.equal(parseWorkflowSettingChanges('优先级：无 → 高\n保留的旧记录'), null);
  assert.equal(parseWorkflowSettingChanges('说明：A → B → C'), null, 'ambiguous legacy text retains its original presentation');
});
