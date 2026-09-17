import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { classroomTodoWindow, classroomTodoTasks, mergeTodoSnapshot, todoDueTime } from '../app/classroom-todo.ts';
import { addAndSelectBoard, adjacentBoardId } from '../app/classroom-boards.ts';
import { createTodoStore } from '../app/api/room/todo/store.ts';
const now = Date.parse('2026-09-11T06:00:00+08:00');
const task = (id, dueDate, done = false, extra = {}) => ({id, title: id, project: 'test', dueDate, done, ...extra});

test('room todo uses the current Shanghai 06:00-to-06:00 window', () => {
  assert.equal(classroomTodoWindow(now - 1).day, '2026-09-10');
  assert.deepEqual(classroomTodoWindow(now - 1), {day:'2026-09-10',start:now-86400000,end:now,next:now});
  assert.deepEqual(classroomTodoWindow(now), {day:'2026-09-11',start:now,end:now+86400000,next:now+86400000});
  assert.deepEqual(classroomTodoWindow(now + 12*3600000), classroomTodoWindow(now));
  assert.equal(classroomTodoWindow(new Date('2026-09-10T22:00:00Z')).day,'2026-09-11');
});
test('todo includes current-window tasks and carries overdue unfinished tasks into following days', () => {
  const tasks = [task('overdue','2026-09-01T12:00:00+08:00'),task('previous','2026-09-10',false,{isAllDay:true}),task('window-done','2026-09-11T06:00:00+08:00',true),task('older-done','2026-09-11T05:59:59+08:00',true,{completedDay:'2026-09-10'}),task('today','2026-09-11',false,{isAllDay:true}),task('today-done','2026-09-11',true,{isAllDay:true}),task('boundary','2026-09-11T06:00:00+08:00'),task('end-minus-one','2026-09-12T05:59:59.999+08:00'),task('next','2026-09-12T06:00:00+08:00'),task('undated',undefined),task('undated-done',undefined,true,{completedDay:'2026-09-11'})];
  const expected=['overdue','previous','window-done','today','today-done','boundary','end-minus-one'];
  assert.deepEqual(classroomTodoTasks(tasks,now).map(t=>t.id),expected);
  assert.deepEqual(classroomTodoTasks(tasks,now+12*3600000).map(t=>t.id),expected);
  assert.deepEqual(classroomTodoTasks(tasks,now+86400000).map(t=>t.id),['overdue','previous','today','boundary','end-minus-one','next']);
  assert.ok(classroomTodoTasks(tasks,now+1).some(t=>t.id==='boundary'));
});
test('all-day tasks end at midnight of the last six oclock day and switch only at six', () => {
  const tasks = [
    task('previous', '2026-09-10', false, { isAllDay: true }),
    task('today', '2026-09-11T00:00:00+0800', false, { isAllDay: true }),
    task('today-done', undefined, true, { isAllDay: true, startDate: '2026-09-11' }),
    task('next', '2026-09-12', false, { isAllDay: true }),
    task('early', '2026-09-11T05:59:59.999+0800'),
    task('six', '2026-09-11T06:00:00+0800'),
    task('undated', undefined, false, { isAllDay: true }),
  ];
  assert.deepEqual(classroomTodoTasks(tasks, Date.parse('2026-09-10T23:59:59.999+0800')).map(t => t.id), ['previous', 'early']);
  for (const time of ['2026-09-11T00:00:00+0800', '2026-09-11T05:59:59.999+0800']) {
    assert.deepEqual(classroomTodoTasks(tasks, Date.parse(time)).map(t => t.id), ['previous', 'early']);
  }
  assert.deepEqual(classroomTodoTasks(tasks, now).map(t => t.id), ['previous', 'today', 'today-done', 'early', 'six']);
  assert.deepEqual(classroomTodoTasks(tasks, Date.parse('2026-09-12T00:00:00+0800')).map(t => t.id), ['previous', 'today', 'today-done', 'early', 'six']);
  assert.deepEqual(classroomTodoTasks(tasks, Date.parse('2026-09-12T06:00:00+0800')).map(t => t.id), ['previous', 'today', 'next', 'early', 'six']);
});

test('all-day UTC timestamps match the same Shanghai date as local timestamps and date-only tasks', () => {
  const values = ['2026-09-11', '2026-09-11T00:00:00+0800', '2026-09-10T16:00:00.000Z'];
  const tasks = values.flatMap((value, i) => [
    task(`end-${i}`, value, false, { isAllDay: true }),
    task(`start-${i}`, undefined, true, { isAllDay: true, startDate: value }),
  ]);
  assert.equal(new Set(tasks.map(todoDueTime)).size, 1);
  assert.equal(classroomTodoTasks(tasks, now).length, 6);
  assert.equal(classroomTodoTasks(tasks, Date.parse('2026-09-12T02:00:00+0800')).length, 6);
  assert.equal(classroomTodoTasks(tasks, now - 1).length, 0);
  assert.deepEqual(classroomTodoTasks(tasks, now + 86400000).map(t => t.id), ['end-0', 'end-1', 'end-2']);
});

test('overdue completions stay only for their completion day without reviving older or undated history', () => {
  const checked = task('checked', '2026-09-01', true, { isAllDay: true, completedDay: '2026-09-11' });
  const tasks = [checked, task('old', '2026-09-01', true, { completedDay: '2026-09-10' }), task('unknown', '2026-09-01', true), task('undated', undefined, true, { completedDay: '2026-09-11' }), task('invalid', 'invalid', false), task('start-only', undefined, false, { startDate: '2026-09-01T16:00:00Z', isAllDay: true })];
  assert.deepEqual(classroomTodoTasks(tasks, now).map(t => t.id), ['checked', 'start-only']);
  assert.deepEqual(mergeTodoSnapshot([checked], [], now + 86400000 - 1), [checked]);
  assert.deepEqual(mergeTodoSnapshot([checked], [], now + 86400000), []);
  assert.deepEqual(mergeTodoSnapshot([checked], [{ ...checked, done: false, completedDay: undefined }], now), [checked]);
  const nextOccurrence = { ...checked, dueDate: '2026-09-11', done: false, completedDay: undefined };
  assert.deepEqual(mergeTodoSnapshot([checked], [nextOccurrence], now), [nextOccurrence]);
});

test('timed tasks use the later valid start or end including reversed dates and timezone offsets', () => {
  const tasks = [
    task('end-in', '2026-09-11T08:00:00+0800', false, { startDate: '2026-09-10T20:00:00+0800' }),
    task('start-in', '2026-09-10T20:00:00+0800', true, { startDate: '2026-09-11T08:00:00+0800' }),
    task('end-out', '2026-09-12T06:00:00+0800', false, { startDate: '2026-09-11T08:00:00+0800' }),
    task('start-out', '2026-09-11T08:00:00+0800', false, { startDate: '2026-09-12T06:00:00+0800' }),
    task('start-only', undefined, false, { startDate: '2026-09-10T22:00:00Z' }),
    task('invalid-end', 'invalid', false, { startDate: '2026-09-11T08:00:00+0800' }),
    task('invalid', 'invalid', false, { startDate: 'invalid' }),
  ];
  assert.deepEqual(classroomTodoTasks(tasks, now).map(t => t.id), ['end-in', 'start-in', 'start-only', 'invalid-end']);
  assert.equal(todoDueTime(tasks[4]), now);
  const checked = { ...tasks[0], done: true, completedDay: '2026-09-11' };
  const moved = { ...checked, startDate: '2026-09-11T12:00:00+0800', done: false, completedDay: undefined };
  assert.deepEqual(mergeTodoSnapshot([checked], [moved], now), [moved], 'a later start identifies a different task occurrence even if the end field is unchanged');
});

test('checks stay for the completion day after refresh, and leave at the next six oclock', () => {
  const done = task('one','2026-09-11',true,{completedDay:'2026-09-11'});
  assert.deepEqual(mergeTodoSnapshot([done],[],now),[done]);
  assert.deepEqual(mergeTodoSnapshot([done],[{...done,done:false,completedDay:undefined}],now),[done]);
  assert.deepEqual(mergeTodoSnapshot([done],[],now+86400000),[]);
  const repeat=task('one','2026-09-11T13:00:00+08:00');
  assert.deepEqual(mergeTodoSnapshot([done],[repeat],now),[repeat]);
});
test('completion snapshots are durable, concurrent member writes stay independent',async()=>{
  const root=path.resolve('codex-generated/classroom-todo-tests'); await mkdir(root,{recursive:true});
  const dir=await mkdtemp(path.join(root,'case-')), store=createTodoStore(dir);
  const a=task('same','2026-09-01'), b=task('same','2026-09-11T08:00:00+08:00');
  await Promise.all([store.reconcile('alice',[a],now),store.reconcile('bob',[b],now)]);
  await store.complete('alice','same',now);
  const loaded=createTodoStore(dir);
  assert.equal((await loaded.reconcile('alice',[],now))[0].done,true);
  assert.equal((await loaded.reconcile('bob',[b],now))[0].done,false);
  assert.equal(JSON.parse(await readFile(path.join(dir,'classroom-todo.json'),'utf8')).members.alice.tasks[0].completedDay,'2026-09-11');
  assert.deepEqual(await loaded.reconcile('alice',[],now+86400000),[]);
});
test('creation selects the exact new board, ordered neighbors stop at the default and last boards',()=>{
  let state={boards:[],activeBoardId:''};
  const make=id=>({id,name:id,createdAt:Number(id),strokes:[],texts:[],deletedStrokeIds:[],deletedTextIds:[],epoch:'initial'});
  state=addAndSelectBoard(state,make('2')); assert.equal(state.activeBoardId,'2');
  state=addAndSelectBoard(state,make('1')); assert.equal(state.activeBoardId,'1');
  assert.equal(adjacentBoardId(state.boards,'1',-1),'');
  assert.equal(adjacentBoardId(state.boards,'',-1),'');
  assert.equal(adjacentBoardId(state.boards,'',1),'1');
  assert.equal(adjacentBoardId(state.boards,'2',1),'2');
  for(let i=3;i<=12;i++)state=addAndSelectBoard(state,make(String(i)));
  assert.equal(addAndSelectBoard(state,make('13')),state);
});
