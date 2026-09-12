import assert from 'node:assert/strict';
import test from 'node:test';
import { collaborationDate, collaborationDateAfter, splitCollaborationTasks } from '../app/collaboration-view.ts';

test('drop dates use the preceding Shanghai day without copying its clock time or changing duration', () => {
  const task = { startDate: '2026-09-10T20:15:00Z', dueDate: '2026-09-12T01:30:00Z' };
  const previous = { startDate: null, dueDate: '2026-12-31T17:00:00Z' };
  const fields = collaborationDateAfter(task, previous);
  assert.deepEqual(fields, { startDate: '2026-12-30T20:15:00.000Z', dueDate: '2027-01-01T01:30:00.000Z' });
  assert.equal(Date.parse(fields.dueDate) - Date.parse(fields.startDate), Date.parse(task.dueDate) - Date.parse(task.startDate));
  assert.deepEqual(collaborationDateAfter(task, { startDate: null, dueDate: '2026-09-11T16:30:00Z' }), {});
});

test('undated drops acquire only a date and start-only tasks retain that date model', () => {
  const previous = { startDate: '2026-10-01T00:30:00+0800', dueDate: null };
  assert.deepEqual(collaborationDateAfter({ startDate: null, dueDate: null }, previous), { dueDate: '2026-09-30T16:00:00.000Z' });
  assert.deepEqual(collaborationDateAfter({ startDate: '2026-09-09T08:30:00Z', dueDate: null }, previous), { startDate: '2026-10-01T08:30:00.000Z' });
  assert.deepEqual(collaborationDateAfter(previous, { startDate: null, dueDate: null }), {});
});

test('member lanes retain every task, sort by deadline or start, and preserve undated order without mutating the snapshot', () => {
  const tasks = [
    { id: 'later-deadline', dueDate: '2026-09-12T18:00:00+0800', startDate: '2026-09-01T09:00:00+0800' },
    { id: 'no-date-1', dueDate: null, startDate: null },
    { id: 'start-only', dueDate: null, startDate: '2026-09-09T10:00:00+0800' },
    { id: 'overdue', dueDate: '2025-12-28T00:00:00+0800', startDate: null },
    { id: 'invalid-date', dueDate: 'invalid', startDate: null },
    { id: 'no-date-2', dueDate: null, startDate: null },
  ];
  const original = structuredClone(tasks);
  const { dated, undated } = splitCollaborationTasks(tasks);
  assert.deepEqual(dated.map(task => task.id), ['overdue', 'start-only', 'later-deadline']);
  assert.deepEqual(undated.map(task => task.id), ['no-date-1', 'invalid-date', 'no-date-2']);
  assert.equal(new Set([...dated, ...undated]).size, tasks.length);
  assert.deepEqual(tasks, original);
  assert.equal(collaborationDate(tasks[0]), tasks[0].dueDate);
  assert.equal(collaborationDate(tasks[2]), tasks[2].startDate);
});

test('chronological sorting compares instants across timezones and keeps equal-time tasks in their existing order', () => {
  const tasks = [
    { id: 'later', dueDate: '2026-09-08T12:00:00+0800', startDate: null },
    { id: 'tie-1', dueDate: '2026-09-08T03:00:00Z', startDate: null },
    { id: 'tie-2', dueDate: '2026-09-08T11:00:00+0800', startDate: null },
    { id: 'fallback', dueDate: 'invalid', startDate: '2026-09-07T23:00:00-0300' },
  ];
  assert.deepEqual(splitCollaborationTasks(tasks).dated.map(task => task.id), ['fallback', 'tie-1', 'tie-2', 'later']);
  assert.deepEqual(splitCollaborationTasks([]), { dated: [], undated: [] });
});

test('relative dates prioritize four days before Monday-based this/next-week labels', async () => {
  const { collaborationDateLabel: label } = await import('../app/collaboration-view.ts');
  const now = new Date('2026-09-11T12:00:00+0800');
  const task = day => ({ dueDate: `${day}T00:00:00+0800`, startDate: null, isAllDay: true });
  for (const [date, expected] of [['2026-09-11','今天'],['2026-09-12','明天'],['2026-09-13','后天'],['2026-09-14','大后天'],['2026-09-10','已过期'],['2026-09-15','下周二'],['2026-09-20','下周日'],['2026-09-21','9/21'],['2026-09-06','已过期']]) assert.equal(label(task(date), now),expected);
});

test('relative dates use Shanghai midnight, preserve time, and handle year boundaries and start-only tasks', async () => {
  const { collaborationDateLabel: label } = await import('../app/collaboration-view.ts');
  assert.equal(label({ dueDate: null, startDate: '2026-09-11T16:05:00Z', isAllDay: false },new Date('2026-09-11T15:59:59Z')),'明天 00:05');
  assert.equal(label({ dueDate: '2026-09-11T16:05:00Z', startDate: null, isAllDay: false },new Date('2026-09-11T16:00:00Z')),'今天 00:05');
  assert.equal(label({ dueDate: '2027-01-04T00:00:00+0800', startDate: null, isAllDay: true },new Date('2026-12-31T12:00:00+0800')),'下周一');
  assert.equal(label({ dueDate: 'bad', startDate: null, isAllDay: true }),'');
});


test('expired task labels use the deadline or start fallback and Shanghai all-day boundary', async () => {
  const { collaborationDateLabel: label } = await import('../app/collaboration-view.ts');
  const now = new Date('2026-09-13T12:00:00+08:00');
  const task = { dueDate: '2026-09-13T11:59:59+08:00', startDate: null, isAllDay: false };
  assert.equal(label(task, now), '已过期');
  assert.equal(label({ ...task, dueDate: '2026-09-13T12:00:00+08:00' }, now), '今天 12:00');
  assert.equal(label({ ...task, dueDate: '2026-09-13T13:00:00+08:00', startDate: '2026-09-12T12:00:00+08:00' }, now), '今天 13:00');
  assert.equal(label({ ...task, dueDate: null, startDate: task.dueDate }, now), '已过期');
  assert.equal(label({ ...task, dueDate: 'invalid', startDate: task.dueDate }, now), '已过期');
  assert.equal(label({ ...task, dueDate: null }, now), '');
  const allDay = { ...task, dueDate: '2026-09-12T16:00:00Z', isAllDay: true };
  assert.equal(label(allDay, new Date('2026-09-13T15:59:59.999Z')), '今天');
  assert.equal(label(allDay, new Date('2026-09-13T16:00:00Z')), '已过期');
  assert.equal(label({ ...allDay, dueDate: '2025-12-31' }, new Date('2026-01-01T00:00:00+08:00')), '已过期');
});
