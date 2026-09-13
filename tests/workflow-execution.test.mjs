import test from 'node:test';
import assert from 'node:assert/strict';
import { executionGroups, executionIds, toggleExecution, workflowGroups } from '../app/workflow-execution.ts';

const workflow = (id, claimantId, status, executing = false, priority = 0, createdAt = 1) => ({ id, claimantId, reviewerId: claimantId === 'alice' ? 'bob' : 'alice', status, executing, fields: { priority }, createdAt });
const ids = group => group.workflows.map(item => item.id);

test('workflow overview shows only execution slots by claimant, pinning review before priority and recency', () => {
  const workflows = [
    workflow('own-low', 'alice', 'working', true),
    workflow('other-high', 'bob', 'working', true, 5),
    workflow('own-high-old', 'alice', 'working', true, 5),
    workflow('own-review-low', 'alice', 'submitted', true),
    workflow('own-high-new', 'alice', 'rejected', true, 5, 2),
    workflow('other-review', 'bob', 'submitted', true),
    workflow('own-review-high', 'alice', 'approving', true, 5),
    workflow('own-claimed', 'alice', 'working'),
    workflow('other-claimed', 'bob', 'rejected'),
    workflow('own-completing-without-slot', 'alice', 'approving'),
    workflow('done', 'alice', 'done', true),
    workflow('deleted', 'bob', 'deleted', true),
    { ...workflow('deleting', 'alice', 'working', true), ownerDeletePending: true },
  ];
  const own = ['own-review-high', 'own-review-low', 'own-high-new', 'own-high-old', 'own-low'];
  const other = ['other-review', 'other-high'];
  const groups = workflowGroups(workflows, 'alice');
  assert.deepEqual(groups.map(group => group.title), ['自己的执行中', '对方的执行中']);
  assert.deepEqual(groups.map(ids), [own, other]);
  assert.deepEqual(workflowGroups(workflows, 'bob').map(ids), [other, own]);
  assert.deepEqual(executionGroups(workflows, 'alice').map(ids), [own, ['own-claimed']]);
  assert.deepEqual(executionGroups(workflows, 'bob').map(ids), [other, ['other-claimed']]);
});

test('empty execution sections stay available and selection changes do not regroup unsaved tasks', () => {
  const workflows = [workflow('claimed', 'alice', 'creating')];
  assert.deepEqual(workflowGroups(workflows, 'alice').map(ids), [[], []]);
  const draft = toggleExecution(executionIds(workflows, 'alice'), 'claimed');
  assert.deepEqual(draft, ['claimed']);
  assert.deepEqual(executionGroups(workflows, 'alice').map(ids), [[], ['claimed']]);
  workflows[0].executing = true;
  assert.deepEqual(workflowGroups(workflows, 'alice').map(ids), [['claimed'], []]);
  assert.deepEqual(toggleExecution(['a', 'b', 'c'], 'd'), ['a', 'b', 'c']);
  assert.deepEqual(toggleExecution(['a', 'b', 'c'], 'b'), ['a', 'c']);
});
