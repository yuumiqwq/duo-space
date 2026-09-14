"use client";

import { useState } from 'react';
import type { ClaimWorkflow, WorkflowCommand } from './collaboration-types';

export function WorkflowResyncSettings({ workflow, disabled, perform }: { workflow: ClaimWorkflow; disabled: boolean; perform: (command: WorkflowCommand) => Promise<boolean> }) {
  const [armedTarget, setArmedTarget] = useState<string | null>(null);
  const target = `${workflow.id}:${workflow.version}`, armed = armedTarget === target;
  return <div className="coop-workflow-actions"><button type="button" disabled={disabled} onClick={() => {
    if (!armed) { setArmedTarget(target); return; }
    setArmedTarget(null);
    void perform({ id: crypto.randomUUID(), workflowId: workflow.id, version: workflow.version, action: 'resync-settings' });
  }}>{armed ? '确认以网站设置覆盖滴答' : '以网站设置同步'}</button></div>;
}
