import type { ClaimWorkflow } from './collaboration-types';

export const EXECUTION_LIMIT = 3;
export const executionEligible = (workflow: ClaimWorkflow) => ['creating', 'working', 'rejected'].includes(workflow.status) && !workflow.ownerDeletePending;
export const isExecuting = (workflow: ClaimWorkflow) => !!workflow.executing && executionEligible(workflow);
export const executionReserved = (workflow: ClaimWorkflow) => !workflow.ownerDeletePending && (workflow.status === 'submitted' || (workflow.status === 'approving' && !!workflow.executing));
export const workflowLabel = (workflow: ClaimWorkflow) => workflow.status === 'done' ? '已完成' : workflow.status === 'deleted' ? '已删除' : ['submitted', 'approving'].includes(workflow.status) ? '待审批' : isExecuting(workflow) ? '执行中' : '已认领';
export const executionIds = (workflows: ClaimWorkflow[], actor: string) => workflows.filter(workflow => workflow.claimantId === actor && (isExecuting(workflow) || executionReserved(workflow))).map(workflow => workflow.id);
export function toggleExecution(ids: string[], id: string): string[] {
  if (ids.includes(id)) return ids.filter(item => item !== id);
  return ids.length >= EXECUTION_LIMIT ? ids : [...ids, id];
}
const byPriority = (a: ClaimWorkflow, b: ClaimWorkflow) => (b.fields.priority || 0) - (a.fields.priority || 0) || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
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
