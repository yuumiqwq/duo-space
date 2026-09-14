import test from 'node:test';
import assert from 'node:assert/strict';
import { activeTaskNotice, collectTaskNotices, initializeTaskNotices, unreadTaskNotices, workflowEventPresentation } from '../app/collaboration-notifications.ts';

test('workflow edits and replies increase unread counts without requiring pending approval', () => {
  const workflow = { id: 'work', title: '任务', status: 'working', source: { ownerId: 'alice' }, reviewerId: 'alice', claimantId: 'bob', events: [] };
  const source = { buffer: {}, workflows: { work: workflow } };
  initializeTaskNotices(source);
  const add = (id, type, actorId) => { workflow.events.push({ id, type, actorId, at: 1, comment: '', files: [] }); collectTaskNotices(source); };
  add('edit', 'updated', 'alice'); add('nudge', 'nudge', 'alice'); add('reply', 'reply-nudge', 'bob');
  assert.equal(workflow.status, 'working');
  assert.deepEqual(unreadTaskNotices(source, 'bob').map(item => item.eventId), ['edit', 'nudge']);
  assert.deepEqual(unreadTaskNotices(source, 'alice').map(item => item.eventId), ['reply']);
  assert.equal(unreadTaskNotices(source, 'other').length, 0);
  collectTaskNotices(source); assert.equal(unreadTaskNotices(source, 'bob').length, 2, 'polling does not duplicate counts');
  source.notifications.read.bob = ['workflow:work:edit'];
  const restored = JSON.parse(JSON.stringify(source));
  assert.deepEqual(unreadTaskNotices(restored, 'bob').map(item => item.eventId), ['nudge']);
  workflow.status = 'deleted'; add('delete', 'task-deleted', 'alice');
  assert.equal(unreadTaskNotices(source, 'bob').length, 2, 'archived updates remain unread until viewed');
});

test('automatic status repair and missing-task markers create no unread records, including old stored alerts', () => {
  const workflow = { id: 'work', title: '任务', status: 'submitted', source: { ownerId: 'alice' }, reviewerId: 'alice', claimantId: 'bob', events: [] };
  const source = { buffer: {}, workflows: { work: workflow } };
  initializeTaskNotices(source);
  const silent = ['external-claimant-check', 'external-task-reopened', 'task-relocated', 'task-anomaly'];
  workflow.events.push(...silent.map(type => ({ id: type, type, actorId: '', at: 1, comment: '历史自动提示', files: [] })));
  collectTaskNotices(source); assert.equal(source.notifications.entries.length, 0);
  source.notifications.entries.push(...silent.map(eventType => ({ id: eventType, eventType, kind: 'workflow', actorId: '', recipients: ['alice', 'bob'] })));
  assert.deepEqual(unreadTaskNotices(source, 'alice'), []); assert.deepEqual(unreadTaskNotices(source, 'bob'), []);
});

test('legacy edit presentation preserves known changes and removes transport wording without inventing missing changes', () => {
  const event = { id: 'edit', type: 'update-replaced', actorId: 'alice', at: 1, comment: '此修改由后续详情设置替代', files: [] };
  assert.deepEqual(workflowEventPresentation(event), { ...event, type: 'updated', comment: '' });
  assert.equal(event.comment, '此修改由后续详情设置替代', 'presentation leaves its input intact');
  assert.equal(workflowEventPresentation(event, '优先级：无 → 高').comment, '优先级：无 → 高');
  assert.equal(workflowEventPresentation({ ...event, type: 'updated', comment: '说明：第一版 → 第二版' }, 'unrelated').comment, '说明：第一版 → 第二版');
  const source = { buffer: {}, workflows: { work: { id: 'work', title: '任务', source: { ownerId: 'alice' }, reviewerId: 'alice', claimantId: 'bob', events: [] } } };
  initializeTaskNotices(source);
  source.workflows.work.events.push(event); collectTaskNotices(source);
  source.notifications.entries[0].body = '详情修改已替代：此修改由后续详情设置替代';
  collectTaskNotices(source);
  assert.equal(unreadTaskNotices(source, 'bob')[0].body, '修改了详细设置');
});

test('error notices reach the originating actor separately and become inactive on resolution', () => {
  const workflow = { id: 'work', title: '任务', source: { ownerId: 'alice' }, reviewerId: 'alice', claimantId: 'bob', events: [] };
  const source = { buffer: {}, workflows: { work: workflow } };
  initializeTaskNotices(source);
  workflow.events.push({ id: 'edit', type: 'updated', actorId: 'alice', at: 1, comment: '优先级：无 → 高', files: [] });
  workflow.syncIssue = { id: 'incident', at: 2, recipientId: 'alice', message: '写入失败' };
  collectTaskNotices(source);
  assert.deepEqual(unreadTaskNotices(source, 'alice').map(item => item.kind), ['sync-error']);
  assert.deepEqual(unreadTaskNotices(source, 'bob').map(item => item.kind), ['workflow']);
  assert.equal(unreadTaskNotices(source, 'other').length, 0);
  workflow.syncIssue.message = '版本冲突'; collectTaskNotices(source);
  assert.equal(unreadTaskNotices(source, 'alice')[0].body, '版本冲突');
  const notice = unreadTaskNotices(source, 'alice')[0];
  source.notifications.read.alice = [notice.id];
  collectTaskNotices(source); assert.equal(unreadTaskNotices(source, 'alice').length, 0);
  delete workflow.syncIssue;
  assert.equal(activeTaskNotice(source, notice), false);
  workflow.syncIssue = { id: 'next', at: 3, recipientId: 'alice', message: '再次失败' }; collectTaskNotices(source);
  assert.equal(unreadTaskNotices(source, 'alice').length, 1);
});
