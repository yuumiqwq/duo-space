"use client";

import { useEffect, useRef, useState } from "react";
import { Archive, ArrowLeft, Check, ClipboardCheck, Paperclip, RotateCcw, Send, X } from "lucide-react";
import { TaskDescription } from "./TaskDescription";
import { UnclaimedTaskDetail } from "./UnclaimedTaskDetail";
import { WorkflowSettings } from "./WorkflowSettings";
import { attachmentDisplayText } from "./task-description-attachments";
import { TaskNoticeDot } from "./TaskNoticeDot";
import { silentWorkflowEvent, workflowEventLabels, type TaskNotice } from "./collaboration-notifications";
import type { ClaimWorkflow, CollaborationCommand, CollaborationSnapshot, ExecutionCommand, RoomTask, WorkflowCommand, WorkflowFile } from "./collaboration-types";
import { executionReserved, isExecuting, workflowGroups, workflowLabel } from './workflow-execution';
import { ExecutionPlanner } from './ExecutionPlanner';
import { clipboardFiles } from './cloud-drive-actions';
import { insertAttachmentPlaceholders, pastedAttachmentName } from './task-attachment-labels';
import { readTaskResponse, taskErrorMessage } from './task-request';
import { WorkflowAttachments } from './WorkflowAttachments';

export const workflowStatus: Record<ClaimWorkflow["status"], string> = { creating: "已认领", working: "已认领", submitted: "待审批", rejected: "已认领", approving: "待审批", done: "已完成", deleted: "已删除" };
const eventLabels = workflowEventLabels;
export function ClaimWorkflows({ snapshot, initialId, task, busy, error, perform, onClose, retryUncertain, notices = [], onRead }: { notices?: TaskNotice[]; onRead?: (ids: string[]) => void; snapshot: CollaborationSnapshot; task?: RoomTask; initialId: string | null; busy: boolean; error: string; perform: (command: WorkflowCommand | CollaborationCommand | ExecutionCommand) => Promise<boolean>; onClose: () => void; retryUncertain?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(initialId);
  const [taskSelected, setTaskSelected] = useState(!!task);
  const [archived, setArchived] = useState(false);
  const [arranging, setArranging] = useState(false);
  const retryRequest = useRef(retryUncertain);
  useEffect(() => { retryRequest.current = retryUncertain; }, [retryUncertain]);
  const uncertain = !!retryUncertain;
  useEffect(() => {
    if (!uncertain || busy) return;
    const timer = window.setInterval(() => { if (!document.hidden) retryRequest.current?.(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [uncertain, busy]);
  useEffect(() => { const element = dialog.current, previous = document.activeElement; element?.showModal(); return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  const workflow = snapshot.workflows.find(item => item.id === selected || (taskSelected && task && (item.id === task.workflowId || (item.source.ownerId === task.ownerId && item.source.taskId === task.id) || (item.claimantId === task.ownerId && item.targetId === task.id))));
  const unclaimed = taskSelected && !workflow ? task : undefined;
  const back = () => { setSelected(null); setTaskSelected(false); };
  const name = (id: string) => snapshot.members.find(member => member.id === id)?.name || "成员";
  return <dialog ref={dialog} className="coop-workflows" aria-label="认领工作流程" onCancel={event => { event.preventDefault(); if (!busy && !arranging) onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><div className="coop-workflow-title-actions"><h3><ClipboardCheck size={20} />{archived ? "已归档" : "工作流程"}</h3>{!workflow && !unclaimed && !archived && <button type="button" className="coop-nudge" disabled={busy || uncertain || arranging} onClick={() => setArranging(true)}>安排执行</button>}</div><button className="coop-icon" type="button" aria-label="关闭工作流程" disabled={busy || arranging} onClick={onClose}><X size={20} /></button></header>
    {retryUncertain && <span className="workflow-sync-spinner" role="status" aria-label="正在确认操作结果" />}
    {workflow ? <WorkflowDetail key={workflow.id} notices={notices} onRead={onRead} workflow={workflow} identityId={snapshot.identityId} name={name} busy={busy || !!retryUncertain} error={error} perform={perform} back={back} /> : unclaimed ? <UnclaimedTaskDetail key={`${unclaimed.ownerId || "buffer"}:${unclaimed.id}`} task={unclaimed} identityId={snapshot.identityId} name={name} busy={busy || uncertain} error={error} perform={perform} back={back} /> : <WorkflowList notices={notices} onRead={onRead} workflows={snapshot.workflows} archived={archived} setArchived={setArchived} select={setSelected} name={name} identityId={snapshot.identityId} disabled={busy || uncertain || arranging} />}
    {!workflow && !unclaimed && !arranging && error && <p className="coop-feedback error" role="alert">{taskErrorMessage(error)}</p>}
    {arranging && <ExecutionPlanner snapshot={snapshot} notices={notices} name={name} busy={busy} uncertain={uncertain} error={error} perform={perform} onClose={() => setArranging(false)} />}
  </dialog>;
}
export function WorkflowList({ workflows, archived, setArchived, select, name, notices = [], identityId, disabled = false }: { notices?: TaskNotice[]; onRead?: (ids: string[]) => void; workflows: ClaimWorkflow[]; archived: boolean; setArchived: (value: boolean) => void; select: (id: string) => void; name: (id: string) => string; identityId: string; disabled?: boolean }) {
  const unread = (id: string) => notices.filter(item => item.workflowId === id).map(item => item.id);
  const archiveUnread = workflows.filter(item => ["done", "deleted"].includes(item.status)).reduce((count, item) => count + unread(item.id).length, 0);
  const archivedItems = workflows.filter(item => ['done', 'deleted'].includes(item.status)).sort((a, b) => Number(unread(b.id).length > 0) - Number(unread(a.id).length > 0) || b.updatedAt - a.updatedAt);
  const card = (item: ClaimWorkflow) => <button type="button" className="coop-workflow-card" key={item.id} disabled={disabled} onClick={() => select(item.id)}>
    <span><strong><TaskNoticeDot ids={unread(item.id)} />{item.title}</strong><small>{name(item.claimantId)} 认领 · {name(item.reviewerId)} 审批</small></span>
    <span className="coop-workflow-actions">{!archived && executionReserved(item) && <span className={`coop-workflow-status ${item.status}`}>待审批</span>}{unread(item.id).length ? <span className="coop-workflow-status has-update">有更新</span> : archived ? <span className={`coop-workflow-status ${item.status}`}>{workflowLabel(item)}</span> : null}</span>
  </button>;
  return <>
    <div className="coop-workflow-navigation"><button type="button" className="coop-workflow-back" disabled={disabled} onClick={() => setArchived(!archived)}>{archived ? <><ArrowLeft size={15} />未完成流程</> : <><Archive size={15} />已归档 <span>{archivedItems.length}</span>{archiveUnread > 0 && <span className="task-notice-count" aria-label={`${archiveUnread} 条归档新记录`}>{archiveUnread}</span>}</>}</button></div>
    <div className="coop-workflow-list">
      {archived ? archivedItems.length ? archivedItems.map(card) : <p className="coop-empty">暂无归档任务</p> : workflowGroups(workflows, identityId).map(group => <section className="coop-workflow-group" key={group.title} aria-label={group.title}><h4>{group.title}<span>{group.workflows.length}</span></h4>{group.workflows.map(card)}</section>)}
    </div>
  </>;
}
function WorkflowDetail({ workflow, identityId, name, busy, error, perform, back, notices, onRead }: { notices: TaskNotice[]; onRead?: (ids: string[]) => void; workflow: ClaimWorkflow; identityId: string; name: (id: string) => string; busy: boolean; error: string; perform: (command: WorkflowCommand) => Promise<boolean>; back: () => void }) {
  const [comment, setComment] = useState(""), [files, setFiles] = useState<WorkflowFile[]>([]), [uploading, setUploading] = useState(false), [fileError, setFileError] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const uploadLock = useRef(false), input = useRef<HTMLInputElement>(null), commentEditor = useRef<HTMLTextAreaElement>(null), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const submit = isExecuting(workflow) && !workflow.taskAnomaly && !workflow.editPending && workflow.claimantId === identityId && ["working", "rejected"].includes(workflow.status);
  const review = !workflow.taskAnomaly && !workflow.editPending && workflow.reviewerId === identityId && workflow.status === "submitted";
  const synchronizing = workflow.ownerDeletePending || workflow.reopenPending || workflow.editPending || ['creating', 'approving'].includes(workflow.status);
  const disabled = busy || uploading || !!workflow.ownerDeletePending || workflow.status === 'deleted';
  const feedback = taskErrorMessage(fileError || error || workflow.syncError || workflow.error);
  async function upload(selected: File[]) {
    if (!selected.length || uploadLock.current || disabled || !(submit || review)) return;
    if (files.length + selected.length > 10) { setFileError("每次提交最多 10 个附件"); return; }
    uploadLock.current = true; setUploading(true); setFileError("");
    const start = commentEditor.current?.selectionStart ?? comment.length, end = commentEditor.current?.selectionEnd ?? comment.length;
    const uploaded = [...files], insertedNames: string[] = [];
    try {
      for (const file of selected) {
        if (!active.current) break;
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} 超过 20 MB`);
        const name = pastedAttachmentName(file, uploaded);
        if (insertAttachmentPlaceholders(comment, start, end, [...insertedNames, name]).value.length > 10000) throw new Error('评语过长');
        const response = await fetch(`/api/room/tasks/files?workflow=${encodeURIComponent(workflow.id)}&name=${encodeURIComponent(name)}`, { method: "POST", body: file, signal: AbortSignal.timeout(120000) });
        const data = await readTaskResponse(response, '上传失败');
        if (!data.file?.id || !data.file?.name || !data.file?.url) throw new Error('上传失败');
        if (!active.current) break;
        uploaded.push(data.file); insertedNames.push(data.file.name);
        setFiles(current => [...current, data.file]);
      }
    } catch (cause) { if (active.current) setFileError(taskErrorMessage(cause, '上传失败')); }
    finally {
      uploadLock.current = false;
      if (active.current) {
        setUploading(false);
        if (insertedNames.length) {
          const inserted = insertAttachmentPlaceholders(comment, start, end, insertedNames);
          setComment(inserted.value);
          requestAnimationFrame(() => { if (!active.current) return; commentEditor.current?.focus(); commentEditor.current?.setSelectionRange(inserted.cursor, inserted.cursor); });
        }
      }
    }
  }
  async function act(action: WorkflowCommand["action"]) {
    if (await perform({ id: crypto.randomUUID(), workflowId: workflow.id, version: workflow.version, action, comment, ...(action === "reply-nudge" ? { replyTo: replyTo! } : {}), attachments: files.map(file => file.id) })) { setComment(""); setFiles([]); setReplyTo(null); }
  }
  return <div className="coop-workflow-detail">
    <section className="coop-workflow-main" aria-label="任务内容及操作">
    <button type="button" className="coop-workflow-back" disabled={busy || uploading} onClick={back}><ArrowLeft size={15} />返回列表</button>
    <div className="coop-workflow-heading"><h4>{workflow.title}</h4><span className={`coop-workflow-status ${workflow.status}`}>{workflowLabel(workflow)}</span>
    <div className="coop-workflow-actions">{workflow.reviewerId === identityId && !["creating", "done", "deleted"].includes(workflow.status) && <button type="button" className="coop-nudge" disabled={disabled} onClick={() => void act("nudge")}>催办</button>}{workflow.reviewerId === identityId && !["done", "deleted"].includes(workflow.status) && <button type="button" disabled={disabled} onClick={() => void act("owner-complete")}><Check size={15} />直接完成</button>}
    </div></div>
    {workflow.fields.content && <TaskDescription content={workflow.fields.content} />}
    <p className="coop-workflow-people">{name(workflow.claimantId)} 认领 · {name(workflow.reviewerId)} 审批</p>
    <ol className="coop-workflow-events">{workflow.events.filter(event => event.type !== "completed" && !silentWorkflowEvent(event.type)).map(event => <li key={event.id}><div><strong><TaskNoticeDot ids={notices.filter(item => item.eventId === event.id && item.workflowId === workflow.id).map(item => item.id)} onRead={onRead} />{event.actorId ? name(event.actorId) : "系统"} · {event.type === "claimed" && event.actorId && event.actorId !== workflow.claimantId ? `安排 ${name(workflow.claimantId)} 认领` : eventLabels[event.type] || event.type}</strong><time>{new Date(event.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></div>{event.comment && <p>{event.type === "updated" && event.comment === "任务详情已同步到关联任务；待审批任务需按最新内容重新提交" ? "旧记录未保存具体修改内容" : attachmentDisplayText(event.comment)}</p>}{event.type === "nudge" && workflow.claimantId === identityId && !workflow.events.some(item => item.type === "reply-nudge" && item.replyTo === event.id) && <button type="button" className="coop-workflow-back" disabled={disabled} onClick={() => { setReplyTo(event.id); setComment(""); }}>回复催办</button>}<WorkflowAttachments files={event.files} /></li>)}</ol>
    {workflow.taskAnomaly && <p className="coop-feedback error" role="alert"><small>该任务已被删除</small></p>}
    {!workflow.taskAnomaly && feedback && (!synchronizing || fileError || workflow.ownerDeletePending) && <p className="coop-feedback error" role="alert">{feedback}</p>}
    {replyTo && <div className="coop-workflow-compose"><label htmlFor="workflow-nudge-reply">回复催办</label><textarea id="workflow-nudge-reply" rows={3} maxLength={2000} disabled={disabled} value={comment} onChange={event => setComment(event.target.value)} /><div className="coop-workflow-actions"><button type="button" disabled={disabled} onClick={() => setReplyTo(null)}>取消</button><button type="button" disabled={disabled || !comment.trim()} onClick={() => void act("reply-nudge")}>发送回复</button></div></div>}
    {!replyTo && (submit || review) && <div className="coop-workflow-compose" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={event => { event.preventDefault(); void upload(Array.from(event.dataTransfer.files)); }}>
      <label htmlFor={`comment-${workflow.id}`}>{review ? "审批评语" : "完成说明"}</label><textarea ref={commentEditor} id={`comment-${workflow.id}`} rows={3} value={comment} maxLength={10000} disabled={disabled} onChange={event => setComment(event.target.value)} onPaste={event => { const pasted = clipboardFiles(event.clipboardData); if (pasted.length) { event.preventDefault(); void upload(pasted); } }} />
      <WorkflowAttachments files={files} disabled={disabled} onRemove={(file, label) => { setFiles(current => current.filter(item => item.id !== file.id)); setComment(current => current.replaceAll(`[${label}]`, '')); }} />
      <input ref={input} className="coop-sr-only" type="file" multiple tabIndex={-1} onChange={event => { void upload(Array.from(event.target.files || [])); event.target.value = ""; }} />
      <div className="coop-workflow-actions"><button type="button" disabled={disabled} onClick={() => input.current?.click()}><Paperclip size={15} />{uploading ? "上传中…" : "附件"}</button><span />{submit ? <button type="button" className="primary" disabled={disabled} onClick={() => void act("submit")}><Send size={15} />提交完成</button> : <><button type="button" disabled={disabled} onClick={() => void act("reject")}><RotateCcw size={15} />打回</button><button type="button" className="primary" disabled={disabled} onClick={() => void act("approve")}><Check size={15} />通过</button></>}</div>
    </div>}
    {synchronizing && !workflow.reopenPending && !workflow.taskAnomaly && <span className="workflow-sync-spinner" role="status" aria-label="正在同步任务" />}
    {workflow.status === "submitted" && !review && <p className="coop-workflow-people">等待 {name(workflow.reviewerId)} 审批</p>}
    </section>
    <WorkflowSettings workflow={workflow} identityId={identityId} disabled={disabled} perform={perform} onDeleted={back} />
  </div>;
}
