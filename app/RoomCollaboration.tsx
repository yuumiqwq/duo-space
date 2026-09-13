"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import type { PublicTaskPreview } from "./classroom-view";
import { createPortal } from "react-dom";
import { CircleAlert, Check, ClipboardList, Ellipsis, Loader2, Plus, RefreshCw, X } from "lucide-react";
import type { CollaborationCommand, CollaborationSnapshot, ExecutionCommand, OperationView, RoomTask, ClaimWorkflow, WorkflowCommand } from "./collaboration-types";
import "./room-collaboration.css";
import { TickTickDiagnostics } from "./TickTickDiagnostics";
import { InlineTaskTitle } from "./InlineTaskTitle";
import { collaborationDate, collaborationDateAfter, collaborationDateLabel, collaborationPinColor, splitCollaborationTasks } from "./collaboration-view";
import { CollaborationRecovery } from "./CollaborationRecovery";
import type { TaskNotice } from "./collaboration-notifications";
import { TaskNoticeDot } from "./TaskNoticeDot";
import { TaskNudge } from "./TaskNudge";
import { descriptionAttachments } from "./task-description-attachments";
import { TaskAttachments } from "./TaskDescription";
import { taskDescriptionPreview } from "./task-description";
import { loadTaskStampFonts } from "./task-stamp-fonts";

import { ClaimWorkflows } from "./ClaimWorkflows";
import { applyWorkflowUpdate, removeSnapshotTask, withoutDeletedWorkflowTasks } from './collaboration-snapshot';
import { loadCollaborationSnapshot, mergeCollaborationSnapshot } from './collaboration-loading';
import { inboxClaimant } from './inbox-claim-stamp';
import { InboxClaimStamp } from './InboxClaimStamp';
import { readTaskResponse, taskErrorMessage } from './task-request';

type RequestCommand = WorkflowCommand | ExecutionCommand | { id: string; action: "legacy-reset" } | CollaborationCommand | { id: string; action: "resume" | "cancel" } | { id: string; action: "recover"; target: { id: string; version: string } };
const taskKey = (task: RoomTask) => `${task.ownerId || "buffer"}:${task.id}`;
const taskSource = (task: RoomTask) => ({ ownerId: task.ownerId, taskId: task.id, version: task.version });
const priorities = { 0: "无优先级", 1: "低", 3: "中", 5: "高" };
const operationTime = (value: number) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));

export function RoomCollaboration({ identityId, onChanged, onNotice, onPublicTasks, triggerContent, previewSnapshot, previewAutoOpen = true }: { identityId: string; onChanged: () => Promise<boolean>; onNotice?: (id: string) => void; onPublicTasks?: (tasks: PublicTaskPreview[]) => void; triggerContent?: ReactNode; previewSnapshot?: CollaborationSnapshot; previewAutoOpen?: boolean }) {
  const [stampFontsReady, setStampFontsReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<CollaborationSnapshot | null>(previewSnapshot || null);
  const [taskNotices, setTaskNotices] = useState<TaskNotice[]>([]);
  const [nudge, setNudge] = useState<TaskNotice | null>(null);
  const readIds = useRef(new Set<string>()), sounded = useRef(new Set<string>());
  const noticeVersion = useRef(0);
  const unseenCount = taskNotices.length;
  const workflowNoticeIds = taskNotices.filter(item => item.kind === 'workflow').map(item => item.id);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false), [workflowId, setWorkflowId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [keyboardDrag, setKeyboardDrag] = useState<{ task: RoomTask; owner: string } | null>(null);
  const [editor, setEditor] = useState<RoomTask | null>(null);
  const [uncertain, setUncertain] = useState<RequestCommand | null>(null);
  const [hoverOwner, setHoverOwner] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; task: RoomTask; width: number } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null), membersPane = useRef<HTMLDivElement>(null);
  const locked = useRef(false), fetching = useRef(false), revision = useRef<number | null>(null), generation = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const drag = useRef<{ handle: HTMLElement; pointerId: number; stop: () => void; task: RoomTask; x: number; y: number; moved: boolean; offsetX: number; offsetY: number; width: number } | null>(null);

  useEffect(() => () => { drag.current?.stop(); }, []);
  useEffect(() => { if (snapshot) onPublicTasks?.(snapshot.buffer); }, [snapshot, onPublicTasks]);

  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 2400); return () => clearTimeout(timer); }, [notice]);

  useEffect(() => {
    let active = true;
    // This component mounts with the room, even while the task board is closed.
    // Reopening also retries a failed download; successful loads are shared.
    void loadTaskStampFonts().then(() => { if (active) setStampFontsReady(true); }).catch(() => undefined);
    return () => { active = false; };
  }, [open]);

  const acceptNotices = useCallback((incoming: TaskNotice[], version = 0) => {
    if (version < noticeVersion.current) return;
    noticeVersion.current = version;
    const unread = incoming.filter(item => !readIds.current.has(item.id));
    setTaskNotices(unread);
    if (!document.hidden) {
      const fresh = unread.filter(item => !sounded.current.has(item.id));
      for (const item of fresh) sounded.current.add(item.id);
      if (fresh.length) onNotice?.(fresh.at(-1)!.id);
      setNudge(current => current || unread.find(item => item.eventType === "nudge") || null);
    }
  }, [onNotice]);
  const markRead = useCallback(async (ids: string[]) => {
    const pending = ids.filter(id => !readIds.current.has(id)); if (!pending.length) return;
    const response = await fetch("/api/room/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "read-notices", ids: pending }), signal: AbortSignal.timeout(15000) });
    const data = await readTaskResponse(response, '浏览状态未保存');
    for (const id of pending) readIds.current.add(id);
    acceptNotices(data.notices || [], data.noticeVersion);
  }, [acceptNotices]);
  const markViewed = useCallback((ids: string[]) => { void markRead(ids).catch(() => undefined); }, [markRead]);
  useEffect(() => {
    if (previewSnapshot) {
      if (!previewAutoOpen) return;
      const timer = setTimeout(() => setOpen(true), 0); return () => clearTimeout(timer);
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get("taskboard") !== "1") return;
    const timer = setTimeout(() => { setOpen(true); const id = params.get("workflow"); if (id && /^[a-f0-9-]{36}$/i.test(id)) { setWorkflowId(id); setWorkflowOpen(true); } }, 0);
    return () => clearTimeout(timer);
  }, [previewSnapshot, previewAutoOpen]);

  const load = useCallback(async (force = false) => {
    if (previewSnapshot) return previewSnapshot;
    if (fetching.current && !force) return null;
    if (force) loadController.current?.abort();
    const controller = new AbortController(); loadController.current = controller;
    fetching.current = true; setLoading(true);
    const id = ++generation.current;
    try {
      const data = await loadCollaborationSnapshot({ signal: controller.signal,
        accept: (next, memberId) => {
          if (id !== generation.current) return;
          setSnapshot(current => mergeCollaborationSnapshot(current, next, memberId));
          acceptNotices(next.notices || [], next.noticeVersion);
          revision.current = Math.max(revision.current ?? 0, next.revision);
        },
        settled: () => { if (id === generation.current) { fetching.current = false; setLoading(false); } },
      });
      return id === generation.current ? withoutDeletedWorkflowTasks(data) : null;
    } catch (cause) { if (id === generation.current) setError(taskErrorMessage(cause, '协作区暂时无法读取')); return null; }
  }, [acceptNotices, previewSnapshot]);

  // Warm each member's tasks when entering the classroom. Opening the board
  // shares this request; closing it does not discard useful in-flight reads.
  useEffect(() => {
    if (!identityId || previewSnapshot) return;
    const timer = setTimeout(() => { void load(); }, 0);
    return () => { clearTimeout(timer); generation.current++; fetching.current = false; loadController.current?.abort(); };
  }, [identityId, load, previewSnapshot]);

  useEffect(() => {
    if (!identityId || previewSnapshot) return;
    let stopped = false, polling = false;
    const poll = async () => {
      if (stopped || polling || document.hidden || locked.current) return;
      polling = true;
      const startedGeneration = generation.current;
      try {
        const response = await fetch(open ? "/api/room/tasks?local=1" : "/api/room/tasks?revision=1", { cache: "no-store", signal: AbortSignal.timeout(8000) });
        if (!response.ok) return;
        const data = await response.json();
        if (stopped || locked.current || startedGeneration !== generation.current) return;
        if (revision.current !== null && data.revision < revision.current) return;
        acceptNotices(data.notices || [], data.noticeVersion);
        if (Array.isArray(data.bufferPreview)) onPublicTasks?.(data.bufferPreview);
        if (revision.current !== null && revision.current !== data.revision) void onChanged();
        if (open && Array.isArray(data.buffer) && Array.isArray(data.members) && Array.isArray(data.workflows)) setSnapshot(current => mergeCollaborationSnapshot(current, data));
        revision.current = data.revision;
      } catch { /* Try again on the next poll or focus. */ }
      finally { polling = false; }
    };
    const first = setTimeout(() => void poll(), 0), timer = setInterval(() => void poll(), 5000);
    const focus = () => void poll();
    const visible = () => { if (!document.hidden) { void poll(); if (open && !locked.current && !drag.current) void load(); } };
    window.addEventListener("focus", focus); window.addEventListener("online", focus); document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; clearTimeout(first); clearInterval(timer); window.removeEventListener("focus", focus); window.removeEventListener("online", focus); document.removeEventListener("visibilitychange", visible); };
  }, [identityId, open, onChanged, load, acceptNotices, onPublicTasks, previewSnapshot]);
  useEffect(() => {
    if (!open) return;
    const element = dialog.current, button = trigger.current;
    element?.showModal();
    if (previewSnapshot) return () => { element?.close(); button?.focus({ preventScroll: true }); };
    const first = setTimeout(() => { void load(); }, 0);
    const timer = setInterval(() => { if (!document.hidden && !locked.current && !drag.current) void load(); }, 15000);
    return () => { clearTimeout(first); clearInterval(timer); element?.close(); button?.focus({ preventScroll: true }); };
  }, [open, load, previewSnapshot]);

  async function perform(command: RequestCommand): Promise<boolean> {
    if (previewSnapshot) {
      setSnapshot(current => {
        if (!current) return current;
        const next = structuredClone(current);
        if (command.action === 'arrange-execution') {
          for (const workflow of next.workflows) if (workflow.claimantId === next.identityId) workflow.executing = command.workflowIds.includes(workflow.id);
          next.executionVersion = (next.executionVersion || 0) + 1;
          return next;
        }
        const source = "source" in command ? command.source : undefined;
        const list = source?.ownerId ? next.members.find(member => member.id === source.ownerId)?.tasks : next.buffer;
        const task = list?.find(item => item.id === source?.taskId);
        if (task && "dateAfter" in command && command.dateAfter) {
          const previous = next.members.find(member => member.id === command.dateAfter!.ownerId)?.tasks.find(item => item.id === command.dateAfter!.taskId);
          if (previous) Object.assign(task, collaborationDateAfter(task, previous));
        }
        if (task && command.action === "update") Object.assign(task, command.fields);
        if (task && ["claim", "move", "complete", "delete"].includes(command.action)) {
          list!.splice(list!.indexOf(task), 1);
          if ("destination" in command && command.destination) {
            task.ownerId = command.destination;
            next.members.find(member => member.id === command.destination)?.tasks.push(task);
          }
        }
        if (command.action === "create") next.buffer.push({ ...previewSnapshot.buffer[0], ...command.fields, id: command.id, ownerId: null, workflowId: undefined });
        if (command.action === "update-workflow") {
          const workflow = next.workflows.find(item => item.id === command.workflowId);
          if (workflow) { Object.assign(workflow.fields, command.fields); workflow.title = workflow.fields.title; }
          for (const item of [...next.buffer, ...next.members.flatMap(member => member.tasks)]) if (item.workflowId === command.workflowId) Object.assign(item, command.fields);
        }
        return next;
      });
      if (command.action === "create") setDraftId(null);
      return true;
    }
    if (locked.current) return false;
    generation.current++; fetching.current = false; loadController.current?.abort(); setLoading(false);
    locked.current = true; setBusy(true); setError(""); setNotice(""); setUncertain(command);
    let operation: OperationView | undefined, workflow: ClaimWorkflow | undefined, executionSaved = false;
    try {
      const response = await fetch("/api/room/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command), signal: AbortSignal.timeout(90000) });
      if (!response.ok && response.status < 500) setUncertain(null);
      const data = await readTaskResponse(response, '请求结果未确认，请核对并重试');
      executionSaved = command.action === 'arrange-execution' && data.execution?.id === command.id && Array.isArray(data.workflows);
      if (command.action !== 'legacy-reset' && !executionSaved && !data.operation?.id && !data.workflow?.id) throw new Error('请求结果未确认，请核对并重试');
      operation = data.operation; workflow = data.workflow;
      if (executionSaved) setSnapshot(current => current ? { ...data.workflows.reduce(applyWorkflowUpdate, current), executionVersion: data.execution.version, revision: data.revision } : current);
      if (workflow) setSnapshot(current => current ? applyWorkflowUpdate(current, workflow!) : current);
      const deletedSource = command.action === 'delete' ? command.source : undefined;
      if (operation?.status === 'done' && deletedSource) setSnapshot(current => current ? removeSnapshotTask(current, deletedSource.ownerId, deletedSource.taskId) : current);
      if (workflow && !["update-workflow", "delete-owner-task", "delete-claimed-task"].includes(command.action)) { setWorkflowId(workflow.id); setWorkflowOpen(true); }
      setUncertain(null);
      if ((workflow?.error || workflow?.syncError) && !workflow?.editPending && !workflow?.ownerDeletePending) setError(workflow.syncError || workflow.error);
      else if (operation?.status === "pending") setError(operation.error || "操作尚未完成，请在下方继续处理");
      else setNotice(operation?.status === "cancelled" ? "已取消未完成的操作" : "已保存");
    } catch (cause) { setError(taskErrorMessage(cause, '请求结果未确认，请核对并重试')); }
    finally {
      const deletionConfirmed = workflow?.status === 'deleted' || (operation?.status === 'done' && command.action === 'delete');
      const next = deletionConfirmed ? null : await load(true);
      if (deletionConfirmed) void load(true);
      workflow = next?.workflows.find(item => item.id === workflow?.id || item.id === command.id || item.events.some(event => event.id === command.id) || (command.action === "retry-workflow" && item.id === command.workflowId && item.version !== command.version)) || workflow;
      if (workflow) { setUncertain(null); if (!["update-workflow", "delete-owner-task", "delete-claimed-task"].includes(command.action)) { setWorkflowId(workflow.id); setWorkflowOpen(true); } }
      const known = next?.operations.find(item => item.id === command.id);
      if (known) { setUncertain(null); operation ||= known; }
      if (workflow && !workflow.error && !workflow.syncError) setError('');
      if (operation?.status === "done") { setError(""); setNotice("已保存"); }
      locked.current = false; setBusy(false);
      void onChanged();
    }
    if (operation?.status === "done" || operation?.status === "cancelled") setDraftId(current => current === command.id ? null : current);
    return executionSaved || (workflow ? workflow.status === 'deleted' || (command.action === 'update-workflow' && workflow.events.some(event => event.id === command.id)) || (!workflow.error && !workflow.syncError) : operation?.status === "done");
  }
  const unavailable = busy || !!uncertain;
  const ownerName = (owner: string | null) => owner === null ? "任务板" : snapshot?.members.find(member => member.id === owner)?.name || "成员";
  const canDrop = (owner: string) => owner !== "" && snapshot?.members.some(member => member.id === owner && member.connected && !member.loading && !member.error);
  const move = async (task: RoomTask, owner: string, previous?: RoomTask) => {
    if (unavailable || task.workflowId || task.pending || task.transferBlocked || !canDrop(owner)) return;
    const dateAfter = previous && Object.keys(collaborationDateAfter(task, previous)).length ? taskSource(previous) : undefined;
    if ((task.ownerId || "") === owner) {
      if (dateAfter) await perform({ id: crypto.randomUUID(), action: "update", source: taskSource(task), fields: {}, dateAfter });
      return;
    }
    await perform({ id: crypto.randomUUID(), action: "claim", source: taskSource(task), destination: owner || null, ...(dateAfter ? { dateAfter } : {}) });
  };
  const close = () => { if (!locked.current) { setOpen(false); setEditor(null); setRecoveryOpen(false); setWorkflowOpen(false); setDraftId(null); setKeyboardDrag(null); setHoverOwner(null); setGhost(null); drag.current?.stop(); drag.current = null; } };
  const edit = (task: RoomTask) => {
    setError(""); setKeyboardDrag(null); setHoverOwner(null);
    setEditor(task); setWorkflowId(task.workflowId || null); setWorkflowOpen(true);
  };
  function startDrag(event: PointerEvent<HTMLElement>, task: RoomTask) {
    if (event.button !== 0 || !event.isPrimary || drag.current) return;
    setKeyboardDrag(null);
    const handle = event.currentTarget;
    const rect = handle.closest("article")!.getBoundingClientRect();
    const onMove = (event: globalThis.PointerEvent) => pointerMove(event);
    const onUp = (event: globalThis.PointerEvent) => finishDrag(event);
    const onCancel = (event: globalThis.PointerEvent) => finishDrag(event, true);
    const stop = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); window.removeEventListener("pointercancel", onCancel); handle.removeEventListener("lostpointercapture", lostDrag); };
    handle.setPointerCapture(event.pointerId);
    drag.current = { handle, pointerId: event.pointerId, task, x: event.clientX, y: event.clientY, moved: false, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, width: rect.width, stop };
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp); window.addEventListener("pointercancel", onCancel); handle.addEventListener("lostpointercapture", lostDrag);
    event.preventDefault();
  }
  function lostDrag(event: globalThis.PointerEvent) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    drag.current.stop();
    drag.current = null; setGhost(null); setHoverOwner(null);
  }
  function pointerMove(event: globalThis.PointerEvent) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 7) return;
    current.moved = true;
    setGhost({ x: event.clientX - current.offsetX, y: event.clientY - current.offsetY, task: current.task, width: current.width });
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const target = hit?.closest<HTMLElement>("[data-coop-owner]");
    setHoverOwner(target && canDrop(target.dataset.coopOwner!) ? target.dataset.coopOwner! : null);
    const bounds = membersPane.current?.getBoundingClientRect();
    if (bounds && event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
      if (event.clientX > bounds.right - 55) membersPane.current?.scrollBy({ left: 22 });
      else if (event.clientX < bounds.left + 55) membersPane.current?.scrollBy({ left: -22 });
      if (event.clientY > bounds.bottom - 35) membersPane.current?.scrollBy({ top: 18 });
      else if (event.clientY < bounds.top + 35) membersPane.current?.scrollBy({ top: -18 });
    }
    const list = hit?.closest<HTMLElement>(".coop-task-list");
    const rect = list?.getBoundingClientRect();
    if (rect) { if (event.clientY > rect.bottom - 45) list?.scrollBy({ top: 18 }); else if (event.clientY < rect.top + 45) list?.scrollBy({ top: -18 }); }
  }
  function finishDrag(event: globalThis.PointerEvent, cancel = false) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.stop(); drag.current = null; setGhost(null); setHoverOwner(null);
    if (current.handle.hasPointerCapture(event.pointerId)) current.handle.releasePointerCapture(event.pointerId);
    if (!cancel && current?.moved) {
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const target = hit?.closest<HTMLElement>("[data-coop-owner]");
      if (target) {
        const lane = hit?.closest<HTMLElement>('[data-coop-lane="dated"]');
        const previousCard = Array.from(lane?.querySelectorAll<HTMLElement>("article[data-coop-task]") || []).filter(card => card.dataset.coopTask !== taskKey(current.task)).findLast(card => {
          const rect = card.getBoundingClientRect();
          return event.clientY >= rect.top + rect.height / 2;
        });
        const previous = previousCard && snapshot?.members.find(member => member.id === target.dataset.coopOwner)?.tasks.find(task => taskKey(task) === previousCard.dataset.coopTask);
        void move(current.task, target.dataset.coopOwner!, previous || undefined);
      }
    }
  }
  function card(task: RoomTask, preview = false) {
    const description = task.ownerId === null ? taskDescriptionPreview(descriptionAttachments(task.content || task.desc || "").text) : "";
    const workflow = snapshot?.workflows.find(item => item.id === task.workflowId);
    const stampedClaimant = inboxClaimant(task, workflow);
    const showWorkflow = () => { setEditor(null); setWorkflowId(task.workflowId || null); setWorkflowOpen(true); setError(""); };
    const pending = !!task.pending;
    const controlsLocked = unavailable || pending || !!draftId;
    const cardLocked = controlsLocked || !!workflow;
    const canComplete = (workflow?.reviewerId || task.ownerId || task.publisherId) === identityId;
    const compactClaim = task.ownerId !== null;
    const claimButton = !workflow && task.ownerId !== identityId && task.publisherId !== identityId && canDrop(identityId) ? <button className="coop-claim" type="button" disabled={cardLocked || !!task.transferBlocked} onClick={() => void move(task, identityId)}>认领</button> : null;
    const surfaceDraggable = task.ownerId !== null && !preview && !cardLocked && !task.transferBlocked;
    return <article style={task.ownerId === null ? { '--coop-pin-color': collaborationPinColor(task.id) } as CSSProperties : undefined} data-coop-task={taskKey(task)} data-surface-draggable={surfaceDraggable || undefined} onPointerDown={event => {
      if (!surfaceDraggable || !(event.target instanceof Element) || event.target.closest('button, input, textarea, select, option, a, label, summary, [role="button"], [role="link"], [contenteditable]:not([contenteditable="false"])')) return;
      startDrag(event, task);
    }} className={`coop-task${task.ownerId !== null ? " member-task" : ""} priority-${task.priority}${pending ? " pending" : ""}${!preview && ghost && taskKey(ghost.task) === taskKey(task) ? " dragging" : ""}`} key={taskKey(task)}>
      {task.ownerId === null && <TaskNoticeDot ids={taskNotices.filter(item => item.taskId === task.id).map(item => item.id)} onRead={open && !workflowOpen && !editor && !recoveryOpen && !nudge ? markViewed : undefined} />}
      <div className="coop-task-top"><button className="coop-drag" type="button"  aria-label={`拖动任务 ${task.title}`} aria-pressed={keyboardDrag?.task.id === task.id && keyboardDrag.task.ownerId === task.ownerId} disabled={cardLocked || !!task.transferBlocked}
        onBlur={() => { setKeyboardDrag(null); setHoverOwner(null); }}
        onKeyDown={event => {
          if (![" ", "Enter", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          if (!keyboardDrag && ![" ", "Enter"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          if (event.key === "Escape") { setKeyboardDrag(null); setHoverOwner(null); return; }
          if (!keyboardDrag) { setKeyboardDrag({ task, owner: task.ownerId || "" }); setHoverOwner(task.ownerId || ""); return; }
          if ([" ", "Enter"].includes(event.key)) { void move(keyboardDrag.task, keyboardDrag.owner); setKeyboardDrag(null); setHoverOwner(null); return; }
          const owners = snapshot?.members.filter(member => canDrop(member.id)).map(member => member.id) || [];
          const next = owners[(owners.indexOf(keyboardDrag.owner) + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + owners.length) % owners.length];
          setKeyboardDrag({ task: keyboardDrag.task, owner: next }); setHoverOwner(next);
          const target = Array.from(dialog.current?.querySelectorAll<HTMLElement>("[data-coop-owner]") || []).find(element => element.dataset.coopOwner === next);
          target?.scrollIntoView({ block: "nearest", inline: "nearest" });
        }}
        onPointerDown={event => startDrag(event, task)} />
        <button className="coop-task-title" type="button" disabled={unavailable || pending || !!draftId} aria-label={`任务详情 ${task.title}`} onClick={() => { if (workflow) showWorkflow(); else edit(task); }}>{task.title}</button>
        {task.ownerId !== null && (collaborationDate(task) ? <time className="coop-task-date" dateTime={collaborationDate(task)!}>{collaborationDateLabel(task)}</time> : <span className="coop-task-date coop-date-space" aria-hidden="true" />)}
        {compactClaim && claimButton}
        {task.ownerId === null && <button className="coop-more" type="button"  aria-label={`任务详情 ${task.title}`} disabled={unavailable || pending} onClick={() => { if (workflow) showWorkflow(); else edit(task); }}><Ellipsis size={18} aria-hidden="true" /></button>}
        {canComplete && <button className="coop-complete" type="button"  aria-label={`完成任务 ${task.title}`} disabled={controlsLocked} onClick={() => void perform(workflow ? { id: crypto.randomUUID(), action: "owner-complete", workflowId: workflow.id, version: workflow.version } : { id: crypto.randomUUID(), action: "complete", source: taskSource(task) })}><Check size={15} aria-hidden="true" /></button>}</div>
      {description && <p className="coop-task-description">{description}</p>}
      <TaskAttachments content={task.content || ""} />
      {task.priority !== 0 && <span className="coop-priority-label">{priorities[task.priority]}优先级</span>}
      <div className="coop-task-footer">{((task.ownerId === null && collaborationDate(task)) || task.repeatFlag || (!compactClaim && !!claimButton)) && <div className="coop-task-meta">{task.ownerId === null && collaborationDate(task) && <span >{collaborationDateLabel(task)}</span>}{task.repeatFlag && <span>重复</span>}
        {!compactClaim && claimButton}
      </div>}
      {workflow && task.ownerId === null && <div className="coop-stamp-clip"><span className="coop-claim-stamp" data-fonts-ready={stampFontsReady} aria-label={`认领者：${ownerName(workflow.claimantId)}`}><span className="coop-claim-stamp-name">{ownerName(workflow.claimantId)}</span></span></div>}</div>
      {stampedClaimant && <InboxClaimStamp name={ownerName(stampedClaimant)} fontsReady={stampFontsReady} />}
      {!workflow && task.transferBlocked && <small className="coop-transfer-note">{task.transferBlocked}</small>}
      {pending && <button type="button" className="coop-pending-label" onClick={() => setRecoveryOpen(true)}><CircleAlert size={12} aria-hidden="true" />查看待处理操作</button>}
    </article>;
  }
  function column(owner: string | null, name: string, tasks: RoomTask[], problem?: string, diagnostic?: string, memberLoading = false) {
    const { dated, undated } = splitCollaborationTasks(tasks);
    return <section key={owner || "buffer"} data-coop-owner={owner || ""} className={`coop-column${owner === null ? " buffer" : ""}${hoverOwner === (owner || "") ? " drop-active" : ""}`}>
      <header>{owner !== null && <><span className="coop-notebook-title">title:</span><h3>{name}</h3></>}<span className="coop-count">{memberLoading ? <Loader2 size={14} className="coop-spin" aria-label="正在读取…" /> : tasks.length}</span>{owner === null && <><button type="button" className="coop-recovery-trigger" onClick={() => { setEditor(null); setWorkflowId(null); setWorkflowOpen(true); setError(""); }}><TaskNoticeDot ids={workflowNoticeIds} />工作流程 {workflowNoticeIds.length > 0 && <span className="task-notice-count">{workflowNoticeIds.length}</span>}</button><button type="button" className="coop-icon coop-refresh" disabled={loading || busy}  aria-label="刷新全室任务" onClick={() => { setError(""); void load(); void onChanged(); }}><RefreshCw size={17} className={loading ? "coop-spin" : ""} /></button><button type="button" className="coop-icon coop-close" disabled={busy || !!editor}  aria-label="关闭协作区" onClick={close}><X size={21} /></button></>}</header>
      {problem && <div className="coop-task-list"><p className="coop-empty">{problem}</p>{(diagnostic || owner === identityId) && <TickTickDiagnostics report={diagnostic} />}</div>}
      {problem && !tasks.length ? null : owner !== null ? <div className="coop-member-lanes">{([{ label: "有日期", tasks: dated }, { label: "无日期", tasks: undated }]).map(lane => <section className="coop-lane" data-coop-lane={lane.label === "有日期" ? "dated" : "undated"} key={lane.label} aria-label={`${name}的${lane.label}待办`}><header><h4>{lane.label}</h4><span>{lane.tasks.length}</span></header><div className="coop-task-list">{lane.tasks.map(task => card(task))}</div></section>)}</div> : <div className="coop-task-list">{tasks.map(task => card(task))}{draftId ? <div className="coop-new-task editing"><Plus size={18} aria-hidden="true" /><InlineTaskTitle key={draftId} initialValue="" label="新任务标题" disabled={unavailable || !!snapshot?.operations.some(operation => operation.id === draftId && operation.status === "pending")} onCancel={() => setDraftId(null)} onSave={async title => {
        const done = await perform({ id: draftId, action: "create", fields: { title } }); if (done) setDraftId(null); return done;
      }} /></div> : <button className="coop-new-task" type="button"  aria-label="新建任务" disabled={unavailable} onClick={() => { setDraftId(crypto.randomUUID()); setError(""); }}><Plus size={25} aria-hidden="true" /></button>}</div>}
    </section>;
  }
  const pending = snapshot?.operations.filter(operation => operation.status === "pending") || [];
  return <>
    <button ref={trigger} className="room-collaboration-trigger" type="button" disabled={!identityId}  aria-label={unseenCount ? `任务板，${unseenCount} 条新动态` : "任务板"} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(true); setError(""); }}>{triggerContent || <><ClipboardList size={18} aria-hidden="true" /><span>任务板</span></>}{unseenCount > 0 && <i aria-hidden="true">{unseenCount > 99 ? "99+" : unseenCount}</i>}</button>
    {open && createPortal(<dialog ref={dialog} tabIndex={-1} className="room-collaboration-dialog" aria-label="自习室任务协作" onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => event.stopPropagation()}>
      <div className="coop-surface">
      {!snapshot && <div className="coop-loading-toolbar"><button type="button" className="coop-icon coop-close" disabled={busy || !!editor}  aria-label="关闭协作区" onClick={close}><X size={21} /></button></div>}
      <div className="coop-layout" aria-busy={busy || (loading && !snapshot)}>{snapshot ? <>{column(null, "任务板", snapshot.buffer)}<div ref={membersPane} className="coop-notebook"><div className="coop-members">{snapshot.members.map(member => column(member.id, member.name, member.tasks, member.error, member.diagnostic, member.loading))}</div></div></> : <div className="coop-empty"><p>{loading ? "正在读取…" : "暂时无法读取任务"}</p><button type="button" className="coop-icon" disabled={loading} aria-label="重新读取任务" onClick={() => { setError(""); void load(); }}><RefreshCw size={18} className={loading ? "coop-spin" : ""} /></button>{uncertain && <button type="button" onClick={() => setRecoveryOpen(true)}>查看待处理操作</button>}</div>}</div>
      {!editor && !recoveryOpen && !workflowOpen && (error || notice || busy) && <div className={`coop-toast${error ? " error" : ""}`} role="status">{busy && <Loader2 className="coop-spin" size={14} />}<span>{error || (busy ? "正在保存…" : notice)}</span>{(pending.length > 0 || uncertain) && <button type="button" onClick={() => setRecoveryOpen(true)}>查看</button>}{!busy && <button type="button" aria-label="收起提示" onClick={() => { setError(""); setNotice(""); }}><X size={14} /></button>}</div>}
      {workflowOpen && snapshot && <ClaimWorkflows snapshot={snapshot} notices={taskNotices} onRead={nudge ? undefined : markViewed} initialId={workflowId} task={editor ? (editor.ownerId === null ? snapshot.buffer : snapshot.members.find(member => member.id === editor.ownerId)?.tasks)?.find(task => task.id === editor.id) || editor : undefined} busy={busy} error={error} perform={perform} retryUncertain={uncertain ? () => void perform(uncertain) : undefined} onClose={() => { setWorkflowOpen(false); setEditor(null); }} />}
      {recoveryOpen && <CollaborationRecovery busy={busy} onClose={() => setRecoveryOpen(false)}>
        {error && <p className="coop-feedback error" role="status">{error}</p>}
        {uncertain && !busy && <div className="coop-recovery">上次提交结果未确认。<button type="button" onClick={() => void perform(uncertain)}>核对并重试</button></div>}
        {snapshot?.legacyCleanup?.map((issue, index) => <div className="coop-recovery" key={index}><span><strong>{issue.title}</strong><small>{issue.message}</small></span></div>)}
        {pending.map(operation => <div className="coop-recovery" key={operation.id}><span><strong>{operation.title}</strong><small>{operation.error || "等待继续"}</small><small>发起账号：{ownerName(operation.actorId)} · {operation.createdAt ? operationTime(operation.createdAt) : "首次时间未记录"}</small></span><div className="coop-recovery-actions">{operation.action === "move" ? <button type="button" disabled={unavailable} onClick={() => void perform({ id: crypto.randomUUID(), action: "legacy-reset" })}>重试旧记录回退</button> : <><button type="button" disabled={unavailable} onClick={() => void perform({ id: operation.id, action: "resume" })}>继续</button>{operation.action !== "collect" && <button type="button" disabled={unavailable} onClick={() => void perform({ id: operation.id, action: "cancel" })}>停止重试</button>}</>}</div></div>)}

        {!pending.length && !uncertain && !snapshot?.legacyCleanup?.length && <p className="coop-empty">没有待处理的操作</p>}
      </CollaborationRecovery>}
      <span className="coop-sr-only" aria-live="polite">{keyboardDrag ? `正在移动 ${keyboardDrag.task.title}，目标 ${ownerName(keyboardDrag.owner || null)}，方向键选择，Enter 放下，Esc 取消` : ""}</span>
      </div>
      {ghost && <div className={`coop-drag-ghost${ghost.task.ownerId === null ? " buffer" : ""}`} aria-hidden="true" inert style={{ left: ghost.x, top: ghost.y, width: ghost.width }}>{card(ghost.task, true)}</div>}
    </dialog>, document.body)}
    {nudge && <TaskNudge key={nudge.id} notice={nudge} onRead={markRead} onClose={() => setNudge(null)} />}
  </>;
}
