import type { ClaimWorkflow } from './collaboration-types';

export const EXECUTION_LIMIT = 3;
export const executionEligible = (workflow: ClaimWorkflow) => ['creating', 'working', 'rejected'].includes(workflow.status) && !workflow.ownerDeletePending;
export const isExecuting = (workflow: ClaimWorkflow) => !!workflow.executing && executionEligible(workflow);
export const executionReserved = (workflow: ClaimWorkflow) => !workflow.ownerDeletePending && (workflow.status === 'submitted' || (workflow.status === 'approving' && !!workflow.executing));
export const workflowLabel = (workflow: ClaimWorkflow) => workflow.status === 'done' ? '已完成' : workflow.status === 'deleted' ? '已删除' : ['submitted', 'approving'].includes(workflow.status) ? '待审批' : isExecuting(workflow) ? '进行中' : '已认领';
export const executionIds = (workflows: ClaimWorkflow[], actor: string) => workflows.filter(workflow => workflow.claimantId === actor && (isExecuting(workflow) || executionReserved(workflow))).map(workflow => workflow.id);
export function toggleExecution(ids: string[], id: string): string[] {
  if (ids.includes(id)) return ids.filter(item => item !== id);
  return ids.length >= EXECUTION_LIMIT ? ids : [...ids, id];
}
export function workflowGroups(workflows: ClaimWorkflow[]) {
  const active = workflows.filter(workflow => !['done', 'deleted'].includes(workflow.status));
  const byPriority = (a: ClaimWorkflow, b: ClaimWorkflow) => (b.fields.priority || 0) - (a.fields.priority || 0) || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
  return [
    { title: '进行中', workflows: active.filter(isExecuting).sort(byPriority) },
    { title: '待审批', workflows: active.filter(workflow => ['submitted', 'approving'].includes(workflow.status)).sort(byPriority) },
    { title: '已认领', workflows: active.filter(workflow => !isExecuting(workflow) && !['submitted', 'approving'].includes(workflow.status)).sort(byPriority) },
  ];
}
