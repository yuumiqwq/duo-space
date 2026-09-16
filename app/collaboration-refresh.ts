import type { ClaimWorkflow, CollaborationCommand, CollaborationSnapshot, OperationView } from './collaboration-types';

export const websiteOnlyAction = (action: string) => ['submit', 'reject', 'arrange-execution', 'nudge', 'reply-nudge', 'legacy-reset'].includes(action);

export function refreshMembers(command: { action: string; workflowId?: string; operationId?: string; id: string; source?: CollaborationCommand['source']; destination?: string | null }, snapshot: CollaborationSnapshot | null): string[] {
  if (websiteOnlyAction(command.action) || command.action === 'create') return [];
  const workflow = snapshot?.workflows.find(item => item.id === command.workflowId);
  if (workflow) return [...new Set([workflow.claimantId, ...(workflow.source.ownerId || workflow.reviewerTaskId ? [workflow.reviewerId] : [])])];
  if (command.source) return [...new Set([command.source.ownerId, command.destination].filter((id): id is string => !!id))];
  const operation = snapshot?.operations.find(item => item.id === (command.operationId || command.id));
  if (operation) return [...new Set([operation.from, operation.to].filter((id): id is string => !!id))];
  return snapshot?.members.filter(member => member.connected).map(member => member.id) || [];
}

// Exclude local review stages and communications so they never trigger Dida
// scans on another member's browser. Callers hash the projections on the server.
export function remoteTaskSignatures(workflows: ClaimWorkflow[], operations: OperationView[]): Record<string, string> {
  const entries: Record<string, unknown[]> = {};
  const add = (owner: string, value: unknown) => { (entries[owner] ||= []).push(value); };
  for (const workflow of workflows) {
    const phase = ['working', 'submitted', 'rejected'].includes(workflow.status) ? 'active' : workflow.status;
    const events = workflow.events.filter(event => ['updated', 'completed', 'task-deleted', 'tasks-restored', 'task-relocated', 'external-task-reopened', 'external-owner-complete'].includes(event.type)).map(event => [event.id, event.type]);
    const value = [workflow.id, workflow.targetId, workflow.reviewerTaskId, workflow.fields, phase, !!workflow.editPending, !!workflow.taskAnomaly, !!workflow.reopenPending, events];
    add(workflow.claimantId, value);
    if (workflow.source.ownerId || workflow.reviewerTaskId) add(workflow.reviewerId, value);
  }
  for (const operation of operations) {
    const value = [operation.id, operation.status, operation.updatedAt];
    for (const owner of new Set([operation.from, operation.to])) if (owner) add(owner, value);
  }
  return Object.fromEntries(Object.entries(entries).map(([owner, values]) => [owner, JSON.stringify(values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))]));
}
