import type { ClaimWorkflow } from './collaboration-types';
import { isWorkflowSettingsNotice, type TaskNotice } from './collaboration-notifications.ts';

export const EXECUTION_LIMIT = 3;
type ExecutionState = Pick<ClaimWorkflow, 'status' | 'executing' | 'ownerDeletePending'>;
export type WorkflowAttention = ExecutionState & Pick<ClaimWorkflow, 'id' | 'source'>;
export const executionEligible = (workflow: ExecutionState) => ['creating', 'working', 'rejected'].includes(workflow.status) && !workflow.ownerDeletePending;
export const isExecuting = (workflow: ExecutionState) => !!workflow.executing && executionEligible(workflow);
export const executionReserved = (workflow: ExecutionState) => !workflow.ownerDeletePending && (workflow.status === 'submitted' || (workflow.status === 'approving' && !!workflow.executing));
export const workflowLabel = (workflow: ClaimWorkflow) => workflow.status === 'done' ? '已完成' : workflow.status === 'deleted' ? '已删除' : ['submitted', 'approving'].includes(workflow.status) ? '待审批' : isExecuting(workflow) ? '执行中' : '已认领';
export const executionIds = (workflows: ClaimWorkflow[], actor: string) => workflows.filter(workflow => workflow.claimantId === actor && (isExecuting(workflow) || executionReserved(workflow))).map(workflow => workflow.id);
export function toggleExecution(ids: string[], id: string): string[] {
  if (ids.includes(id)) return ids.filter(item => item !== id);
  return ids.length >= EXECUTION_LIMIT ? ids : [...ids, id];
}
const byPriority = (a: ClaimWorkflow, b: ClaimWorkflow) => (b.fields.priority || 0) - (a.fields.priority || 0) || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
function attentionTasks<T extends ExecutionState & Pick<ClaimWorkflow, 'id'>>(workflows: T[], notices: TaskNotice[]): T[] {
  const updated = new Set(notices.filter(isWorkflowSettingsNotice).map(notice => notice.workflowId));
  return workflows.filter(workflow => executionReserved(workflow) || (isExecuting(workflow) && updated.has(workflow.id)));
}
export function workflowAttentionCount(workflows: (ExecutionState & Pick<ClaimWorkflow, 'id'>)[], notices: TaskNotice[]): number {
  return attentionTasks(workflows, notices).length;
}
export function taskboardAttentionCount(workflows: WorkflowAttention[], notices: TaskNotice[]): number {
  const tasks = new Set(notices.filter(notice => notice.kind === 'public' && notice.taskId).map(notice => `public:${notice.taskId}`));
  for (const workflow of attentionTasks(workflows, notices)) {
    tasks.add(workflow.source.ownerId === null ? `public:${workflow.source.taskId}` : `workflow:${workflow.id}`);
  }
  return tasks.size;
}
const byReviewThenPriority = (a: ClaimWorkflow, b: ClaimWorkflow) => Number(executionReserved(b)) - Number(executionReserved(a)) || byPriority(a, b);
export function workflowGroups(workflows: ClaimWorkflow[], identityId: string) {
  const executing = workflows.filter(workflow => isExecuting(workflow) || executionReserved(workflow));
  return [
    { title: '自己的执行中', workflows: executing.filter(workflow => workflow.claimantId === identityId).sort(byReviewThenPriority) },
    { title: '对方的执行中', workflows: executing.filter(workflow => workflow.claimantId !== identityId).sort(byReviewThenPriority) },
  ];
}
export function executionGroups(workflows: ClaimWorkflow[], identityId: string) {
  const own = workflows.filter(workflow => workflow.claimantId === identityId && (executionEligible(workflow) || executionReserved(workflow)));
  return [
    { title: '执行中任务', workflows: own.filter(workflow => isExecuting(workflow) || executionReserved(workflow)).sort(byReviewThenPriority) },
    { title: '已认领任务', workflows: own.filter(workflow => !isExecuting(workflow) && !executionReserved(workflow)).sort(byPriority) },
  ];
}
