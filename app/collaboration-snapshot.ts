import type { ClaimWorkflow, CollaborationSnapshot } from './collaboration-types';
import { workflowMatchesTask } from './workflow-task-match.ts';

export function removeSnapshotTask(snapshot: CollaborationSnapshot, ownerId: string | null, taskId: string): CollaborationSnapshot {
  return ownerId === null
    ? { ...snapshot, buffer: snapshot.buffer.filter(task => task.id !== taskId) }
    : { ...snapshot, members: snapshot.members.map(member => member.id === ownerId ? { ...member, tasks: member.tasks.filter(task => task.id !== taskId) } : member) };
}

export function applyWorkflowUpdate(snapshot: CollaborationSnapshot, workflow: ClaimWorkflow): CollaborationSnapshot {
  let next = { ...snapshot, workflows: [...snapshot.workflows.filter(item => item.id !== workflow.id), workflow] };
  if (workflow.ownerDeletePending && workflow.events.some(event => event.type === 'task-delete-requested')) {
    if (workflow.source.ownerId === null) next = removeSnapshotTask(next, null, workflow.source.taskId);
    next = { ...next, buffer: next.buffer.filter(task => task.workflowId !== workflow.id) };
  }
  if (workflow.status !== 'deleted') return next;
  return { ...next,
    buffer: next.buffer.filter(task => !workflowMatchesTask(workflow, null, task) && task.workflowId !== workflow.id),
    members: next.members.map(member => ({ ...member, tasks: member.tasks.filter(task => !workflowMatchesTask(workflow, member.id, task)) })),
  };
}

export function withoutDeletedWorkflowTasks(snapshot: CollaborationSnapshot): CollaborationSnapshot {
  return snapshot.workflows.filter(workflow => workflow.status === 'deleted' || workflow.ownerDeletePending).reduce(applyWorkflowUpdate, snapshot);
}
