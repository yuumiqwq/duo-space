import test from 'node:test';
import assert from 'node:assert/strict';
import { dateInput, apiDate, allDaySelection, taskDateInputs, taskDateSelection } from '../app/task-date-input.ts';

test('task editors retain Shanghai dates across UTC day boundaries and preserve empty/all-day fields', () => {
  assert.equal(dateInput(null, true), '');
  assert.equal(dateInput('2026-09-11T16:00:00Z', true), '2026-09-12');
  assert.equal(dateInput('2026-09-11T22:00:00Z', false), '2026-09-12T06:00');
  assert.equal(dateInput('2026-09-12T05:59:00+0800', false), '2026-09-12T05:59');
  assert.equal(apiDate('', true), null);
  assert.equal(apiDate('2026-09-12', true), '2026-09-12T00:00:00+0800');
  assert.equal(apiDate('2026-09-12', true, true), '2026-09-12T23:59:00+0800');
  assert.equal(apiDate('2026-09-12T06:00', false, true), '2026-09-12T06:00:00+0800');
});

test('a Dida single-day pair displays as one date and moving or clearing it updates both fields', () => {
  const day = '2026-09-12T16:00:00.000Z';
  for (const dates of [{ startDate: day, dueDate: day }, { startDate: day, dueDate: null }, { startDate: null, dueDate: day }]) {
    const fields = { ...dates, isAllDay: true };
    assert.deepEqual(taskDateInputs(fields), { start: '2026-09-13', due: '' });
    assert.deepEqual(taskDateSelection(fields, '2026-09-13', ''), dates, 'unrelated edits preserve raw stored dates');
    assert.deepEqual(taskDateSelection(fields, '2026-09-15', ''), { startDate: '2026-09-15T00:00:00+0800', dueDate: '2026-09-15T00:00:00+0800' });
    assert.deepEqual(taskDateSelection(fields, '', ''), { startDate: null, dueDate: null });
  }
});

test('all-day selection distinguishes a day, a multi-day range and timed fields', () => {
  const empty = { isAllDay: true, startDate: null, dueDate: null };
  for (const [start, due] of [['2026-09-13', ''], ['', '2026-09-13'], ['2026-09-13', '2026-09-13']]) {
    assert.deepEqual(taskDateSelection(empty, start, due), { startDate: '2026-09-13T00:00:00+0800', dueDate: '2026-09-13T00:00:00+0800' });
  }
  const range = taskDateSelection(empty, '2026-09-13', '2026-09-15');
  assert.deepEqual(range, { startDate: '2026-09-13T00:00:00+0800', dueDate: '2026-09-15T23:59:00+0800' });
  assert.deepEqual(taskDateInputs({ ...range, isAllDay: true }), { start: '2026-09-13', due: '2026-09-15' });
  assert.deepEqual(taskDateSelection({ ...empty, isAllDay: false }, '2026-09-13T09:00', ''), { startDate: '2026-09-13T09:00:00+0800', dueDate: null });
  assert.deepEqual(taskDateInputs({ isAllDay: false, startDate: '2026-09-13T09:00:00+0800', dueDate: '2026-09-13T18:00:00+0800' }), { start: '2026-09-13T09:00', due: '2026-09-13T18:00' });
  const oldSameDayRange = { isAllDay: true, startDate: '2026-09-13T00:00:00+0800', dueDate: '2026-09-13T23:59:00+0800' };
  assert.deepEqual(taskDateSelection(oldSameDayRange, '2026-09-13', ''), { startDate: oldSameDayRange.startDate, dueDate: oldSameDayRange.dueDate });
});

test('new all-day selections persist a concrete day for reminders and recurrence without changing timed requests', () => {
  const date = '2026-09-12T16:00:00.000Z';
  for (const settings of [{}, { reminders: ['TRIGGER:PT0S'] }, { repeatFlag: 'RRULE:FREQ=DAILY' }]) {
    assert.deepEqual(allDaySelection({ isAllDay: true, startDate: date, dueDate: null, ...settings }), { isAllDay: true, startDate: date, dueDate: date, ...settings });
  }
  const timed = { isAllDay: false, startDate: date, dueDate: null };
  assert.equal(allDaySelection(timed), timed);
});
