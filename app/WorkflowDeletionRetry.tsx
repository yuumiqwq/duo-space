"use client";

import { useState } from 'react';
import type { ClaimWorkflow, WorkflowCommand } from './collaboration-types';

export function WorkflowDeletionRetry({ workflow, identityId, disabled, perform }: { workflow: ClaimWorkflow; identityId: string; disabled: boolean; perform: (command: WorkflowCommand) => Promise<boolean> }) {
  const [armedTarget, setArmedTarget] = useState<string | null>(null);
  const target = `${workflow.id}:${workflow.version}`, armed = armedTarget === target;
  if (workflow.status !== 'deleted' || workflow.error !== '滴答清单中删除失败' || ![workflow.reviewerId, workflow.claimantId].includes(identityId)) return null;
  return <div className="coop-workflow-actions"><button type="button" disabled={disabled || workflow.deletionPending} onClick={() => {
    if (!armed) { setArmedTarget(target); return; }
    setArmedTarget(null);
    void perform({ id: crypto.randomUUID(), workflowId: workflow.id, version: workflow.version, action: 'retry-deletion' });
  }}>{armed ? '确认删除剩余滴答副本' : '重试删除滴答副本'}</button></div>;
}
