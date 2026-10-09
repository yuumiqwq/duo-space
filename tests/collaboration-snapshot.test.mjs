import test from 'node:test';
import assert from 'node:assert/strict';
import {applyWorkflowUpdate,removeSnapshotTask,withoutDeletedWorkflowTasks} from '../app/collaboration-snapshot.ts';
import { mergeCollaborationSnapshot } from '../app/collaboration-loading.ts';
test('confirmed deletion immediately removes only related cards and preserves archived history',()=>{
  const workflow={id:'w',status:'working',source:{ownerId:null,taskId:'public'},claimantId:'bob',reviewerId:'alice',targetId:'target',reviewerTaskId:'reviewer',events:[{id:'history'}]};
  const snapshot={buffer:[{id:'public',workflowId:'w'},{id:'other'}],members:[{id:'alice',tasks:[{id:'reviewer'},{id:'other'}]},{id:'bob',tasks:[{id:'target'},{id:'other'}]}],workflows:[workflow]};
  assert.equal(applyWorkflowUpdate(snapshot,{...workflow,ownerDeletePending:true}).buffer.length,2,'pending flag alone does not authorize whole-task removal');
  const deleted={...workflow,status:'deleted'};
  const result=applyWorkflowUpdate(snapshot,deleted);
  assert.deepEqual(result.buffer,[{id:'other'}]);
  assert.ok(result.members.every(member=>member.tasks.length===1&&member.tasks[0].id==='other'));
  assert.deepEqual(result.workflows,[deleted]);assert.equal(snapshot.buffer.length,2,'no mutation of an older snapshot');
  assert.deepEqual(withoutDeletedWorkflowTasks({...snapshot,workflows:[deleted]}),result,'a stale public card cannot reappear with archived deletion history');
  assert.deepEqual(removeSnapshotTask(snapshot,null,'public').buffer,[{id:'other'}]);
});

test('accepted whole-task deletion hides public cards while retaining unconfirmed inbox tasks and history', () => {
  const workflow = { id: 'w', status: 'working', source: { ownerId: null, taskId: 'public' }, claimantId: 'bob', targetId: 'target', events: [{ id: 'history', comment: '保留材料', files: [{ id: 'file' }] }] };
  const snapshot = { buffer: [{ id: 'public', workflowId: 'w' }, { id: 'other' }], members: [{ id: 'bob', tasks: [{ id: 'target' }] }], workflows: [workflow] };
  const pending = { ...workflow, ownerDeletePending: true, events: [...workflow.events, { id: 'deletion', type: 'task-delete-requested' }] };
  const result = applyWorkflowUpdate(snapshot, pending);
  assert.deepEqual(result.buffer, [{ id: 'other' }]);
  assert.deepEqual(result.members, snapshot.members);
  assert.deepEqual(result.workflows, [pending]);
  assert.deepEqual(withoutDeletedWorkflowTasks({ ...snapshot, workflows: [pending] }), result);
  assert.equal(snapshot.buffer.length, 2, 'the previous snapshot remains intact');
  for (const type of ['owner-task-deleted', 'claimant-task-deleted']) {
    const legacy = { ...pending, events: [...workflow.events, { id: 'deletion', type }] };
    assert.deepEqual(withoutDeletedWorkflowTasks({ ...snapshot, workflows: [legacy] }).buffer, snapshot.buffer);
  }
});

test('deleted recurring archives hide only their own occurrence across full, partial and command snapshots', () => {
  const fields = { repeatFlag: 'RRULE:FREQ=DAILY', startDate: '2026-10-08T00:00:00+08:00', dueDate: '2026-10-08T00:00:00+08:00' };
  const workflow = { id: 'archive', status: 'deleted', fields, source: { ownerId: 'alice', taskId: 'source' }, claimantId: 'bob', reviewerId: 'alice', targetId: 'target', reviewerTaskId: 'reviewer', events: [{ id: 'materials', files: [{ id: 'submitted' }] }] };
  const old = (id, ownerId) => ({ ...fields, id, ownerId, startDate: '2026-10-07T16:00:00Z', dueDate: '2026-10-07T16:00:00Z' });
  const later = (id, ownerId, workflowId) => ({ ...fields, id, ownerId, workflowId, startDate: '2026-10-09T00:00:00+08:00', dueDate: '2026-10-09T00:00:00+08:00' });
  for (const workflowId of [undefined, 'new-workflow']) {
    const snapshot = { identityId: 'alice', revision: 5, buffer: [], workflows: [workflow], members: [
      { id: 'alice', connected: true, tasks: [later('source', 'alice', workflowId), old('reviewer', 'alice')] },
      { id: 'bob', connected: true, tasks: [later('target', 'bob', workflowId)] },
    ] };
    const check = result => {
      assert.deepEqual(result.members.map(member => member.tasks.map(task => task.id)), [['source'], ['target']]);
      assert.deepEqual(result.workflows[0].events, workflow.events);
    };
    check(withoutDeletedWorkflowTasks(snapshot));
    check(mergeCollaborationSnapshot(null, snapshot));
    check(mergeCollaborationSnapshot(snapshot, { ...snapshot, members: [snapshot.members[0]] }, 'alice'));
    check(applyWorkflowUpdate({ ...snapshot, workflows: [] }, workflow));
  }
  const differentAssociation = { identityId: 'alice', revision: 6, buffer: [], workflows: [workflow], members: [{ id: 'alice', tasks: [{ ...old('source', 'alice'), workflowId: 'new-workflow' }] }] };
  assert.equal(withoutDeletedWorkflowTasks(differentAssociation).members[0].tasks.length, 1, 'another explicit workflow association wins over the archived ID');
  assert.equal(withoutDeletedWorkflowTasks({ ...differentAssociation, members: [{ id: 'alice', tasks: [old('source', 'alice')] }] }).members[0].tasks.length, 0, 'an old response still cannot restore the deleted occurrence');
});
