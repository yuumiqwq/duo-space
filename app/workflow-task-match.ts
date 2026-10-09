import type { ClaimWorkflow, RoomTask, TaskFields } from './collaboration-types';

const date = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export function sameWorkflowOccurrence(fields: Partial<TaskFields>, task: Partial<TaskFields>) {
  return !fields.repeatFlag || (date(fields.startDate) === date(task.startDate) && date(fields.dueDate) === date(task.dueDate));
}
export function workflowMatchesTask(workflow: ClaimWorkflow, ownerId: string | null, task: RoomTask) {
  if (task.workflowId && task.workflowId !== workflow.id) return false;
  const linked = (workflow.source.ownerId === ownerId && workflow.source.taskId === task.id)
    || (workflow.claimantId === ownerId && workflow.targetId === task.id)
    || (workflow.reviewerId === ownerId && workflow.reviewerTaskId === task.id);
  return linked && sameWorkflowOccurrence(workflow.fields || {}, task);
}
export function activeTaskWorkflow(workflows: ClaimWorkflow[], task: RoomTask) {
  const active = workflows.filter(workflow => !['done', 'deleted'].includes(workflow.status));
  if (task.workflowId) return active.find(workflow => workflow.id === task.workflowId);
  return active.find(workflow => workflowMatchesTask(workflow, task.ownerId, task));
}
