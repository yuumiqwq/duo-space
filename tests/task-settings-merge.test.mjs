import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTaskSettings } from '../app/task-settings-merge.ts';
import { taskFields } from '../app/api/room/tasks/store.ts';

test('three-way settings merge keeps independent changes, recognizes partial writes and rejects conflicting groups', () => {
  const base = taskFields({ title: 'task', content: 'old', priority: 1 });
  const desired = { ...base, priority: 5, startDate: '2026-10-01T00:00:00+0800', dueDate: '2026-10-01T00:00:00+0800' };
  for (const priority of [1, 5]) {
    const result = mergeTaskSettings(base, desired, { ...base, priority, content: 'remote' });
    assert.deepEqual(result.conflicts, []); assert.equal(result.fields.content, 'remote'); assert.equal(result.fields.priority, 5);
    assert.equal(result.fields.startDate, desired.startDate);
  }
  assert.deepEqual(mergeTaskSettings(base, desired, { ...base, priority: 3 }).conflicts, ['priority']);
  for (const patch of [{ dueDate: '2026-11-01T00:00:00Z' }, { reminders: ['TRIGGER:PT0S'] }, { repeatFlag: 'RRULE:FREQ=DAILY' }, { isAllDay: false }]) {
    assert.ok(mergeTaskSettings(base, desired, { ...base, ...patch }).conflicts.length, JSON.stringify(patch));
  }
  const reminder = { ...base, reminders: ['TRIGGER:PT0S'] };
  assert.ok(mergeTaskSettings(base, reminder, { ...base, dueDate: desired.dueDate }).conflicts.includes('dueDate'));
  assert.deepEqual(mergeTaskSettings(base, { ...base, title: 'local' }, { ...base, tags: ['b', 'a'], items: [{ title: 'new', id: 'remote' }] }).fields.items, [{ title: 'new', id: 'remote' }]);
});
