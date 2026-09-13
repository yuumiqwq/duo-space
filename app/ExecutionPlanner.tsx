"use client";

import { useEffect, useRef, useState } from 'react';
import { Check, ClipboardCheck, X } from 'lucide-react';
import type { CollaborationSnapshot, ExecutionCommand } from './collaboration-types';
import type { TaskNotice } from './collaboration-notifications';
import { TaskNoticeDot } from './TaskNoticeDot';
import { executionEligible, executionGroups, executionIds, executionReserved, toggleExecution } from './workflow-execution';
import { taskErrorMessage } from './task-request';

export function ExecutionPlanner({ snapshot, notices = [], name, busy, uncertain, error, perform, onClose }: { snapshot: CollaborationSnapshot; notices?: TaskNotice[]; name: (id: string) => string; busy: boolean; uncertain: boolean; error: string; perform: (command: ExecutionCommand) => Promise<boolean>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), saving = useRef(false);
  const [draft, setDraft] = useState(() => ({ ids: executionIds(snapshot.workflows, snapshot.identityId), version: snapshot.executionVersion || 0 }));
  const [limitWarning, setLimitWarning] = useState(0);
  const disabled = busy || uncertain;
  useEffect(() => { const element = dialog.current, previous = document.activeElement; element?.showModal(); return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  useEffect(() => { if (!limitWarning) return; const timer = setTimeout(() => setLimitWarning(0), 2200); return () => clearTimeout(timer); }, [limitWarning]);
  function toggle(id: string) {
    const workflow = snapshot.workflows.find(item => item.id === id);
    if (disabled || saving.current || !workflow || workflow.claimantId !== snapshot.identityId || !executionEligible(workflow)) return;
    const ids = toggleExecution(draft.ids, id);
    if (ids === draft.ids) { setLimitWarning(current => current + 1); return; }
    setDraft({ ...draft, ids });
  }
  async function save() {
    if (disabled || saving.current) return;
    saving.current = true;
    try {
      if (await perform({ id: crypto.randomUUID(), action: 'arrange-execution', version: draft.version, workflowIds: draft.ids })) onClose();
    } finally { saving.current = false; }
  }
  return <dialog ref={dialog} className="coop-workflows" aria-label="安排执行" onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy && !saving.current) onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><div className="coop-workflow-title-actions"><h3><ClipboardCheck size={20} />安排执行</h3><button type="button" className="coop-nudge" disabled={disabled} onClick={() => void save()}>保存</button></div><button type="button" className="coop-icon" aria-label="关闭安排执行" disabled={busy} onClick={() => { if (!saving.current) onClose(); }}><X size={20} /></button></header>
    <div className="coop-workflow-list">
      {executionGroups(snapshot.workflows, snapshot.identityId).map(group => <section className="coop-workflow-group" key={group.title} aria-label={group.title}>
        <h4>{group.title}<span>{group.workflows.length}</span></h4>
        {group.workflows.map(item => <button type="button" className="coop-workflow-card" key={item.id} role="checkbox" aria-checked={draft.ids.includes(item.id)} disabled={disabled || !executionEligible(item)} onClick={() => toggle(item.id)}>
          <span><strong><TaskNoticeDot ids={notices.filter(notice => notice.workflowId === item.id).map(notice => notice.id)} />{item.title}</strong><small>{name(item.claimantId)} 认领 · {name(item.reviewerId)} 审批</small></span>
          <span className="coop-workflow-actions">{executionReserved(item) && <span className={`coop-workflow-status ${item.status}`}>待审批</span>}<span className="coop-complete coop-execution-checkbox" aria-hidden="true">{draft.ids.includes(item.id) && <Check size={16} />}</span></span>
        </button>)}
      </section>)}
    </div>
    {uncertain && <span className="workflow-sync-spinner" role="status" aria-label="正在确认操作结果" />}
    {error && <p className="coop-feedback error" role="alert">{taskErrorMessage(error)}</p>}
    {!!limitWarning && <div className="coop-toast coop-execution-limit" role="status">执行中任务最多3个</div>}
  </dialog>;
}
