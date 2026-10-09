"use client";
import type { Dispatch,RefObject,SetStateAction } from "react";
import { useCallback,useEffect,useRef,useState } from "react";
import type { PublicTaskPreview } from "../classroom-view";
import { loadCollaborationSnapshot,mergeCollaborationSnapshot } from '../collaboration-loading';
import { type TaskNotice } from "../collaboration-notifications";
import { refreshMembers,websiteOnlyAction } from "../collaboration-refresh";
import { applyWorkflowUpdate,removeSnapshotTask,withoutDeletedWorkflowTasks } from '../collaboration-snapshot';
import type { ClaimWorkflow,CollaborationCommand,CollaborationSnapshot,ExecutionCommand,OperationResyncCommand,OperationView,RoomTask,WorkflowCommand } from "../collaboration-types";
import { collaborationDateAfter } from "../collaboration-view";
import { readTaskResponse,taskErrorMessage } from '../task-request';
import { type WorkflowAttention } from '../workflow-execution';
type RequestCommand = WorkflowCommand | ExecutionCommand | OperationResyncCommand | { id: string; action: "legacy-reset" } | CollaborationCommand | { id: string; action: "resume" | "cancel" } | { id: string; action: "recover"; target: { id: string; version: string } };
type Options = {
  previewSnapshot: CollaborationSnapshot | undefined;
  onPublicTasks: ((tasks: PublicTaskPreview[]) => void) | undefined;
  acceptNotices: (incoming: TaskNotice[], version?: number) => void;
  identityId: string;
  open: boolean;
  onChanged: (fresh?: boolean) => Promise<boolean>;
  drag: RefObject<{ handle: HTMLElement; pointerId: number; stop: () => void; task: RoomTask; x: number; y: number; moved: boolean; offsetX: number; offsetY: number; width: number; } | null>;
  setDraftId: Dispatch<SetStateAction<string | null>>;
  setWorkflowId: Dispatch<SetStateAction<string | null>>;
  setWorkflowOpen: Dispatch<SetStateAction<boolean>>;
};
export function useCollaborationSession({ previewSnapshot, onPublicTasks, acceptNotices, identityId, open, onChanged, drag, setDraftId, setWorkflowId, setWorkflowOpen }: Options) {

  const [snapshot, setSnapshot] = useState<CollaborationSnapshot | null>(previewSnapshot || null);
  const [attention, setAttention] = useState<{ revision: number; workflows: WorkflowAttention[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState<RequestCommand | null>(null);
  const locked = useRef(false), fetching = useRef(false), revision = useRef<number | null>(null), generation = useRef(0);
  const remoteVersions = useRef<Record<string, string> | null>(null);
  const loadController = useRef<AbortController | null>(null);
  useEffect(() => { if (snapshot) onPublicTasks?.(snapshot.buffer); }, [snapshot, onPublicTasks]);

  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 2400); return () => clearTimeout(timer); }, [notice]);

  const load = useCallback(async (force = false, memberIds?: string[]) => {
    if (previewSnapshot) return previewSnapshot;
    if (memberIds?.length === 0) {
      const id = generation.current;
      try {
        return await loadCollaborationSnapshot({ signal: AbortSignal.timeout(8000), memberIds, settled() {}, accept: next => {
          if (id !== generation.current) return;
          setSnapshot(current => mergeCollaborationSnapshot(current, next));
          acceptNotices(next.notices || [], next.noticeVersion);
          revision.current = Math.max(revision.current ?? 0, next.revision);
        } });
      } catch (cause) { if (id === generation.current) setError(taskErrorMessage(cause, '协作区暂时无法读取')); return null; }
    }
    if (fetching.current && !force) return null;
    if (force) loadController.current?.abort();
    const controller = new AbortController(); loadController.current = controller;
    fetching.current = true; setLoading(true);
    const id = ++generation.current;
    try {
      const data = await loadCollaborationSnapshot({ signal: controller.signal, memberIds,
        accept: (next, memberId) => {
          if (id !== generation.current) return;
          setSnapshot(current => mergeCollaborationSnapshot(current, next, memberId));
          if (remoteVersions.current === null) remoteVersions.current = { ...next.remoteVersions };
          if (memberId) remoteVersions.current[memberId] = next.remoteVersions?.[memberId] || "";
          else {
            for (const member of next.members) if (!member.connected) remoteVersions.current[member.id] = next.remoteVersions?.[member.id] || '';
            for (const member of Object.keys(remoteVersions.current)) if (!next.members.some(item => item.id === member)) delete remoteVersions.current[member];
          }
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
    // The generation token invalidates every in-flight read at cleanup time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        if (Array.isArray(data.attentionWorkflows)) setAttention(current => current && current.revision > data.revision ? current : { revision: data.revision, workflows: data.attentionWorkflows });
        if (Array.isArray(data.bufferPreview)) onPublicTasks?.(data.bufferPreview);
        const versions: Record<string, string> = data.remoteVersions || {};
        const changed = remoteVersions.current === null ? [] : [...new Set([...Object.keys(versions), ...Object.keys(remoteVersions.current)])].filter(id => (versions[id] || "") !== (remoteVersions.current![id] || ""));
        if (changed.length && !fetching.current) {
          void load(false, changed);
          if (changed.includes(identityId)) void onChanged(true);
        }
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
  }, [identityId, open, onChanged, load, acceptNotices, onPublicTasks, previewSnapshot, drag]);

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
    const affectedMembers = refreshMembers(command, snapshot), localAction = websiteOnlyAction(command.action);
    if (affectedMembers.length) { generation.current++; fetching.current = false; loadController.current?.abort(); setLoading(false); }
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
      if (!localAction && (workflow?.error || workflow?.syncError) && !workflow?.editPending && !workflow?.ownerDeletePending) setError(workflow.syncError || workflow.error);
      else if (operation?.status === "pending") setError(operation.error || "操作尚未完成，请在下方继续处理");
      else if (localAction || !workflow?.editPending) setNotice(operation?.status === "cancelled" ? "已取消未完成的操作" : "已保存");
    } catch (cause) { setError(taskErrorMessage(cause, '请求结果未确认，请核对并重试')); }
    finally {
      const deletionConfirmed = workflow?.status === 'deleted' || (operation?.status === 'done' && command.action === 'delete');
      const next = deletionConfirmed ? null : await load(true, affectedMembers);
      if (deletionConfirmed) void load(true, affectedMembers);
      workflow = next?.workflows.find(item => item.id === workflow?.id || item.id === command.id || item.events.some(event => event.id === command.id) || (command.action === "retry-workflow" && item.id === command.workflowId && item.version !== command.version)) || workflow;
      if (workflow) { setUncertain(null); if (!["update-workflow", "delete-owner-task", "delete-claimed-task"].includes(command.action)) { setWorkflowId(workflow.id); setWorkflowOpen(true); } }
      const known = next?.operations.find(item => item.id === command.id);
      if (known) { setUncertain(null); operation ||= known; }
      if (workflow && !workflow.error && !workflow.syncError) setError('');
      if (operation?.status === "done") { setError(""); setNotice("已保存"); }
      locked.current = false; setBusy(false);
      if (affectedMembers.includes(identityId)) void onChanged(true);
    }
    if (operation?.status === "done" || operation?.status === "cancelled") setDraftId(current => current === command.id ? null : current);
    return executionSaved || (workflow ? (localAction && workflow.events.some(event => event.id === command.id)) || workflow.status === 'deleted' || (command.action === 'update-workflow' && workflow.events.some(event => event.id === command.id)) || (!workflow.error && !workflow.syncError) : operation?.status === "done");
  }
  const unavailable = busy || !!uncertain;
  return { snapshot, attention, loading, busy, error, setError, notice, setNotice, uncertain, locked, load, perform, unavailable };
}
