import test from 'node:test';
import assert from 'node:assert/strict';
import { claimantSettingsNotices, taskCardNotices, executionGroups, executionIds, toggleExecution, workflowGroups, workflowAttentionCount, taskboardAttentionCount } from '../app/workflow-execution.ts';

const workflow = (id, claimantId, status, executing = false, priority = 0, createdAt = 1) => ({ id, claimantId, reviewerId: claimantId === 'alice' ? 'bob' : 'alice', status, executing, fields: { priority }, createdAt });
const ids = group => group.workflows.map(item => item.id);

test('workflow entry badge counts only pending reviews regardless of unread edits', () => {
  const workflows = [
    workflow('own-updated', 'alice', 'working', true), workflow('other-review', 'bob', 'submitted', true),
    workflow('own-review', 'alice', 'approving', true), workflow('own-idle', 'alice', 'working'),
    workflow('other-idle', 'bob', 'working'), workflow('archived', 'bob', 'deleted', true),
    workflow('done', 'alice', 'done', true), workflow('only-nudge', 'bob', 'working', true),
    workflow('only-error', 'alice', 'working', true), workflow('no-slot-completing', 'bob', 'approving'),
    { ...workflow('deleting', 'bob', 'submitted', true), ownerDeletePending: true },
  ];
  const settings = ['own-updated', 'own-updated', 'other-review', 'own-idle', 'other-idle', 'archived', 'done', 'no-slot-completing', 'deleting'].map((workflowId, index) => ({ id: String(index), workflowId, kind: 'workflow', eventType: 'updated' }));
  const other = [{ workflowId: 'only-nudge', kind: 'workflow', eventType: 'nudge' }, { workflowId: 'only-error', kind: 'sync-error' }];
  assert.equal(workflowAttentionCount(workflows, [...settings, ...other]), 2);
  assert.equal(workflowAttentionCount(workflows, other), 2, 'reading settings has no effect on the review count');
  assert.equal(workflowAttentionCount(workflows.map(item => ({ ...item, status: 'done' })), settings), 0);
  assert.equal(workflowAttentionCount([], settings), 0, 'old notices without a visible workflow do not count');
});

test('claimant edit dots include unarranged tasks, exclude own edits and disappear after read acknowledgement', () => {
  const claimed = { ...workflow('claimed', 'alice', 'working'), source: { ownerId: null, taskId: 'public' } };
  const notices = [
    { id: 'other-edit', workflowId: claimed.id, kind: 'workflow', eventType: 'updated', actorId: 'bob' },
    { id: 'third-edit', workflowId: claimed.id, kind: 'workflow', eventType: 'updated', actorId: 'charlie', recipients: ['alice', 'bob'] },
    { id: 'own-edit', workflowId: claimed.id, kind: 'workflow', eventType: 'updated', actorId: 'alice' },
    { id: 'reject', workflowId: claimed.id, kind: 'workflow', eventType: 'reject', actorId: 'bob' },
    { id: 'failure', workflowId: claimed.id, kind: 'sync-error', actorId: '' },
  ];
  assert.deepEqual(claimantSettingsNotices(claimed, notices, 'alice'), ['other-edit', 'third-edit', 'reject']);
  assert.deepEqual(claimantSettingsNotices(claimed, notices, 'bob'), []);
  assert.equal(taskboardAttentionCount([claimed], notices, 'alice'), 1, 'several edits count as one task without an execution slot');
  assert.equal(taskboardAttentionCount([claimed], notices, 'bob'), 0);
  assert.equal(workflowAttentionCount([claimed]), 0);
  const read = notices.filter(notice => !['other-edit', 'third-edit', 'reject'].includes(notice.id));
  assert.deepEqual(claimantSettingsNotices(claimed, read, 'alice'), []);
  assert.equal(taskboardAttentionCount([claimed], read, 'alice'), 0);
  assert.equal(taskboardAttentionCount([{ ...claimed, status: 'submitted', executing: true }], notices, 'alice'), 1, 'pending review and a dot share one count');
  for (const status of ['done', 'deleted']) assert.deepEqual(claimantSettingsNotices({ ...claimed, status }, notices, 'alice'), []);
});

test('public notes and member cards share update and rejection dots with one task count', () => {
  const claimed = { ...workflow('work', 'bob', 'rejected', true), source: { ownerId: null, taskId: 'public' } };
  const card = { id: 'copy', ownerId: 'bob' }, note = { id: 'public', ownerId: null };
  const notices = [{ id: 'new', kind: 'public', taskId: 'public' }, { id: 'reject', kind: 'workflow', eventType: 'reject', workflowId: 'work', actorId: 'alice', rejection: { claimantId: 'bob', dismissed: true } }];
  assert.deepEqual(taskCardNotices(card, claimed, notices, 'bob'), ['new', 'reject']);
  assert.deepEqual(taskCardNotices(note, claimed, notices, 'bob'), ['new', 'reject']);
  assert.equal(taskboardAttentionCount([claimed], notices, 'bob'), 1);
  assert.equal(workflowAttentionCount([claimed]), 0);
  for (const task of [card, note]) assert.deepEqual(taskCardNotices(task, claimed, [], 'bob'), []);
});

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

test('main taskboard counts unread public tasks and execution attention without counting other notices or duplicate tasks', () => {
  const linked = (id, status, executing, sourceId = id) => ({ ...workflow(id, 'bob', status, executing), source: { ownerId: null, taskId: sourceId } });
  const workflows = [linked('updated', 'working', true, 'public-updated'), linked('review', 'submitted', true), linked('idle', 'working', false), linked('deleted', 'deleted', true), linked('only-error', 'working', true)];
  const notices = [
    { kind: 'public', taskId: 'new-public' }, { kind: 'public', taskId: 'new-public' }, { kind: 'public', taskId: 'public-updated' },
    ...['updated', 'updated', 'review', 'idle', 'deleted'].map(workflowId => ({ kind: 'workflow', workflowId, eventType: 'updated' })),
    { kind: 'workflow', workflowId: 'only-error', eventType: 'nudge' }, { kind: 'sync-error', workflowId: 'only-error' },
  ];
  assert.equal(taskboardAttentionCount(workflows, notices), 3, 'one new task, one updated task and one review; shared public source counted once');
  assert.equal(taskboardAttentionCount(workflows, notices.filter(item => item.kind !== 'public')), 2);
  assert.equal(taskboardAttentionCount(workflows, []), 1, 'a viewed task remains counted while awaiting review');
  assert.equal(taskboardAttentionCount(workflows.map(item => ({ ...item, status: 'done' })), []), 0);
  assert.equal(taskboardAttentionCount([], notices), 2, 'unarranged and archived workflows cannot inflate the main count');
});
