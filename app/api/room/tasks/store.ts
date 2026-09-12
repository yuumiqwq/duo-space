import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { workflowSettingChanges } from "../../../workflow-setting-changes.ts";
import { collaborationDate, collaborationDateAfter } from "../../../collaboration-view.ts";
import { clearLegacyRecords } from "../../../legacy-record-cleanup.ts";
import { collectTaskNotices, initializeTaskNotices, receivesTaskNotice, silentWorkflowEvent, unreadTaskNotices, type TaskNotice, type TaskNoticeState } from "../../../collaboration-notifications.ts";
import type { ClaimWorkflow, WorkflowCommand, WorkflowFile, CollaborationCommand, CollaborationSnapshot, ExecutionCommand, OperationView, RoomTask, TaskFields, TaskSource } from "../../../collaboration-types";
import { EXECUTION_LIMIT, executionEligible, executionReserved, isExecuting } from '../../../workflow-execution.ts';
import { descriptionAttachments } from "../../../task-description-attachments.ts";

export type RemoteTask = Partial<TaskFields> & { id: string; projectId: string; status?: number; parentId?: string; [key: string]: unknown };
export type Gateway = {
  members(): Promise<{ id: string; name: string; connected: boolean }[]>;
  inbox(owner: string): Promise<{ projectId: string; tasks: RemoteTask[] }>;
  get(owner: string, id: string, projectId?: string): Promise<RemoteTask | null>;
  locate?(owner: string, id: string, projectId?: string, completedAfter?: number): Promise<RemoteTask | null>;
  notify?(notice: TaskNotice): Promise<void>;
  taskAttachments?: { publish(actor: string, before: string, after: string): Promise<void>; remove(files: string[]): Promise<void> };
  create(owner: string, id: string, fields: TaskFields, receipt?: (actualId: string) => Promise<void>): Promise<void>;
  update(owner: string, id: string, fields: TaskFields, version: string, projectId?: string): Promise<void>;
  remove(owner: string, id: string, projectId?: string): Promise<void>;
  complete(owner: string, id: string, projectId?: string): Promise<void>;
  reopen(owner: string, before: RemoteTask, completedAfter?: number): Promise<RemoteTask>;
  checkTransfer(owner: string, task: RemoteTask): Promise<void>;
};
type BufferTask = { fields: TaskFields; version: number; stagedBy?: string; publisherId?: string; publishedAt?: number; completedAt?: number };
type Creation = { state: "new" | "sent" | "received"; beforeIds?: string[] };
type AttachmentChange = { actor: string; before: string; after: string; publishBefore?: string };
type WorkflowEdit = { id: string; fields: TaskFields; attachments?: AttachmentChange; summary?: string; targets?: { owner: string; id: string; before: string; done: boolean }[] };
type WorkflowSide = "source" | "target";
type ReviewDecision = { comment: string; files: WorkflowFile[] };
type TaskRecovery = { id: string; creation: Creation; done?: boolean };
type Workflow = ClaimWorkflow & { completionRequest?: { id: string; actor: string; signature: string; review?: ReviewDecision }; publishedAt?: number; missingGeneration?: number; restoration?: { id: string; generation: number }; ownerDeletion?: { id: string; done?: WorkflowSide[] }; syncRetryAt?: number; syncAttempts?: number; reopenReceipt?: { before: RemoteTask; retryAt: number }; sourceReopenReceipt?: { before: RemoteTask; retryAt: number }; submittedFields?: { source: TaskFields; target: TaskFields }; projects?: Partial<Record<WorkflowSide, string>>; recovery?: Partial<Record<WorkflowSide, TaskRecovery>>; signature: string; targetCreation: Creation; reviewerCreation?: Creation; approval?: { targetDone: boolean; sourceDone: boolean; sourceSent?: boolean; targetSent?: boolean; repeating?: boolean }; submitted?: { source: string; target: string }; edit?: WorkflowEdit };
type Operation = OperationView & {
  signature: string; source?: TaskSource; fields: TaskFields; targetId: string;
  attachments?: AttachmentChange;
  phase: "prepared" | "destination-ready" | "source-removed";
  creation?: { state: "new" | "sent" | "received"; beforeIds?: string[] };
};
type State = { version: 1; revision: number; buffer: Record<string, BufferTask>; operations: Record<string, Operation>; workflows: Record<string, Workflow>; executionPlans?: Record<string, { version: number; receipts: { id: string; signature: string }[] }>; notifications?: TaskNoticeState; legacyCleanup?: { title: string; message: string }[]; legacyReset?: boolean };
export const isPersonalCollection = (workflow: ClaimWorkflow) => workflow.source.ownerId === null && workflow.reviewerId === workflow.claimantId;
export function collectionOperation(workflow: ClaimWorkflow): OperationView {
  return { id: workflow.id, actorId: workflow.events[0]?.actorId || workflow.claimantId, title: workflow.title, action: "collect", from: null, to: workflow.claimantId, status: workflow.status === "done" && !workflow.editPending ? "done" : "pending", error: workflow.error, createdAt: workflow.createdAt, updatedAt: workflow.updatedAt };
}
export class CollaborationError extends Error {
  status: number;
  diagnostic?: string;
  constructor(message: string, status = 409, diagnostic?: string) { super(message); this.status = status; this.diagnostic = diagnostic; }
}
const canonicalDate = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export function taskFields(task: Partial<TaskFields>): TaskFields {
  return {
    title: task.title || "", content: task.content || "", priority: [0, 1, 3, 5].includes(task.priority || 0) ? task.priority || 0 : 0,
    startDate: canonicalDate(task.startDate), dueDate: canonicalDate(task.dueDate), isAllDay: task.isAllDay ?? true, timeZone: task.timeZone || "Asia/Shanghai",
    tags: task.tags || [], reminders: task.reminders || [], repeatFlag: task.repeatFlag || "", repeatFrom: String(task.repeatFrom ?? "2"), desc: task.desc || "", kind: task.kind || "TEXT", items: task.items || [],
  };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export const remoteVersion = (task: RemoteTask) => fingerprint({ fields: taskFields(task), status: task.status || 0, parentId: task.parentId || "", desc: task.desc || "", etag: task.etag || "" });
function comparableFields(task: Partial<TaskFields>) {
  const fields = taskFields(task);
  // Dida can reorder tags/reminders and choose a default repeat origin even
  // when repetition is disabled. These do not change the user's task.
  // A single all-day date can also be returned as start=end. Limit that
  // equivalence to tasks without recurrence or deadline-based reminders.
  const dueDate = fields.isAllDay && !fields.repeatFlag && !fields.reminders.length ? fields.dueDate ?? fields.startDate : fields.dueDate;
  // Copied checklist items receive new provider IDs. Compare their content in
  // order, retaining all other fields; remoteVersion still includes raw IDs.
  const items = fields.items.map(item => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'id')));
  return { ...fields, dueDate, items, tags: [...new Set(fields.tags)].sort(), reminders: [...new Set(fields.reminders)].sort(), repeatFrom: fields.repeatFlag ? fields.repeatFrom : '' };
}
export const sameFields = (a: Partial<TaskFields>, b: Partial<TaskFields>) => fingerprint(comparableFields(a)) === fingerprint(comparableFields(b));
const fieldLabels: Record<keyof TaskFields, string> = { title: "标题", content: "说明", priority: "优先级", startDate: "开始时间", dueDate: "截止时间", isAllDay: "全天设置", timeZone: "时区", tags: "标签", reminders: "提醒", repeatFlag: "重复规则", repeatFrom: "重复计算方式", desc: "检查项说明", kind: "任务类型", items: "检查项" };
export function fieldDifferences(a: Partial<TaskFields>, b: Partial<TaskFields>): string[] {
  const left = comparableFields(a), right = comparableFields(b);
  return (Object.keys(fieldLabels) as (keyof TaskFields)[]).filter(key => fingerprint(left[key]) !== fingerprint(right[key])).map(key => fieldLabels[key]);
}
export function verificationIssue(task: RemoteTask | null, fields: TaskFields): string {
  if (!task) return "尚未读到接收方副本，原任务仍保留";
  if (task.status) return "接收方副本已完成或状态改变，原任务仍保留";
  return `接收方副本核对不一致：${fieldDifferences(task, fields).join("、")}；原任务仍保留`;
}
export function validateFields(input: unknown): Partial<TaskFields> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CollaborationError("任务内容无效", 400);
  const value = input as Record<string, unknown>, result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (["title", "content", "repeatFlag"].includes(key)) {
      if (typeof item !== "string" || item.length > (key === "title" ? 500 : 10000) || (key === "title" && !item.trim())) throw new CollaborationError("请检查任务标题或内容长度", 400);
      result[key] = key === "title" ? item.trim() : item;
    } else if (key === "priority") {
      if (![0, 1, 3, 5].includes(item as number)) throw new CollaborationError("优先级无效", 400);
      result[key] = item;
    } else if (key === "isAllDay") {
      if (typeof item !== "boolean") throw new CollaborationError("全天设置无效", 400); result[key] = item;
    } else if (key === "startDate" || key === "dueDate") {
      if (item !== null && (typeof item !== "string" || !/[zZ]|[+-]\d\d:?\d\d$/.test(item) || !canonicalDate(item))) throw new CollaborationError("日期必须包含有效的时区", 400);
      result[key] = canonicalDate(item);
    } else if (key === "tags" || key === "reminders") {
      if (!Array.isArray(item) || item.length > 30 || item.some(text => typeof text !== "string" || text.length > 200)) throw new CollaborationError("标签或提醒设置无效", 400); result[key] = item;
    } else if (key === "timeZone") {
      if (typeof item !== "string") throw new CollaborationError("时区无效", 400);
      try { new Intl.DateTimeFormat("en", { timeZone: item }); } catch { throw new CollaborationError("时区无效", 400); } result[key] = item;
    } else throw new CollaborationError("包含不支持编辑的字段", 400);
  }
  return result as Partial<TaskFields>;
}

export class CollaborationStore {
  private queue: Promise<unknown> = Promise.resolve();
  private maintenance?: Promise<void>;
  private maintenanceAfter = 0;
  private file: string;
  private gateway: Gateway;
  constructor(directory: string, gateway: Gateway) { this.file = path.join(directory, "room-collaboration.json"); this.gateway = gateway; }
  private async read(): Promise<State> {
    try {
      const state = JSON.parse(await readFile(this.file, "utf8"));
      if (state.version !== 1 || !state.buffer || !state.operations) throw new Error("协作记录格式异常");
      state.workflows ||= {};
      // An accepted whole-task deletion removes the public card immediately,
      // even while linked inbox deletions are waiting for provider confirmation.
      // Old one-sided deletion receipts do not authorize removing another copy.
      for (const workflow of Object.values(state.workflows) as Workflow[]) {
        // Initialize existing claims once. Pending submissions retain their
        // execution slot and review history; ordinary claims start unarranged.
        // Public tasks without a claimant have no workflow and are untouched.
        workflow.executing ??= !isPersonalCollection(workflow) && !workflow.ownerDeletion && (workflow.status === 'submitted' || (workflow.status === 'approving' && workflow.events.some(event => event.type === 'submit')));
        const deleting = workflow.ownerDeletion && workflow.events.some(event => event.id === workflow.ownerDeletion?.id && event.type === 'task-delete-requested');
        if ((workflow.status === 'deleted' || deleting) && workflow.source.ownerId === null) delete state.buffer[workflow.source.taskId];
      }
      for (const [id, task] of Object.entries(state.buffer) as [string, BufferTask][]) {
        const publication = (Object.values(state.operations) as Operation[]).find(op => op.action === "create" && op.targetId === id);
        task.publisherId ||= publication?.actorId;
        task.publishedAt ??= publication?.createdAt;
      }
      initializeTaskNotices(state); return state;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, revision: 0, buffer: {}, operations: {}, workflows: {}, notifications: { known: [], entries: [], read: {}, attempted: [] } }; throw error; }
  }
  private async write(state: State) {
    collectTaskNotices(state);
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try { await rename(temp, this.file); break; }
        catch (error) { if (process.platform !== "win32" || attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code || "")) throw error; await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt)); }
      }
    } finally { await unlink(temp).catch(() => undefined); }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> { const result = this.queue.then(work); this.queue = result.catch(() => undefined); return result; }
  private async source(state: State, source: TaskSource): Promise<{ fields: TaskFields; version: string; remote?: RemoteTask } | null> {
    if (source.ownerId === null) { const task = Object.hasOwn(state.buffer, source.taskId) ? state.buffer[source.taskId] : null; return task && !task.completedAt ? { fields: task.fields, version: String(task.version) } : null; }
    const task = await this.gateway.get(source.ownerId, source.taskId);
    return task ? { fields: taskFields(task), version: remoteVersion(task), remote: task } : null;
  }
  private async checkpoint(state: State, op: Operation) { op.updatedAt = Date.now(); state.revision++; await this.write(state); }
  private async finish(state: State, op: Operation) {
    if (op.attachments) {
      // Persist accepted task contents before removing files, so interruption
      // leaves a resumable cleanup receipt rather than an old broken task.
      await this.checkpoint(state, op);
      await this.cleanAttachments(state, op.attachments);
    }
    if (op.to === null && state.buffer[op.targetId]?.stagedBy === op.id) delete state.buffer[op.targetId].stagedBy;
    op.status = "done"; op.error = ""; await this.checkpoint(state, op);
  }
  private publicOperation(op: Operation): OperationView { const { id, actorId, title, action, from, to, status, error, createdAt, updatedAt } = op; return { id, actorId, title, action, from, to, status, error, ...(createdAt === undefined ? {} : { createdAt }), updatedAt }; }
  private async cleanAttachments(state: State, change: AttachmentChange) {
    if (!this.gateway.taskAttachments) return;
    const paths = (content: string) => descriptionAttachments(content).attachments.map(file => file.path);
    const remaining = new Set(paths(change.after));
    const removed = [...new Set(paths(change.before))].filter(file => !remaining.has(file));
    if (!removed.length) return;
    for (const task of Object.values(state.buffer)) paths(task.fields.content).forEach(file => remaining.add(file));
    for (const workflow of Object.values(state.workflows).filter(item => item.status !== 'done')) paths((workflow.edit?.fields || workflow.fields).content).forEach(file => remaining.add(file));
    for (const op of Object.values(state.operations).filter(item => item.status === 'pending')) paths(op.fields.content).forEach(file => remaining.add(file));
    // Shared links remain valid while another current task still uses the file.
    for (const member of (await this.gateway.members()).filter(item => item.connected)) {
      for (const task of (await this.gateway.inbox(member.id)).tasks.filter(item => !item.status)) paths(task.content || '').forEach(file => remaining.add(file));
    }
    await this.gateway.taskAttachments.remove(removed.filter(file => !remaining.has(file)));
  }
  private async candidates(state: State, op: Operation) {
    if (!op.to) return [];
    const inbox = await this.gateway.inbox(op.to);
    const locked = new Set(Object.values(state.operations).filter(other => other.id !== op.id && other.status === "pending").flatMap(other => [other.to === op.to ? other.targetId : "", other.source?.ownerId === op.to ? other.source.taskId : ""]));
    return inbox.tasks.filter(task => !task.status && !locked.has(task.id) && !op.creation?.beforeIds?.includes(task.id) && sameFields(task, op.fields));
  }
  async revision(actor?: string) {
    const state = await this.read();
    const bufferIds = Object.entries(state.buffer).filter(([, task]) => !task.stagedBy && !task.completedAt).map(([id]) => id);
    // Reuse the existing revision request for the idle classroom board. This
    // reads local public tasks only; it never fetches a member's TickTick inbox.
    const bufferPreview = bufferIds.slice(0, 6).map(id => ({ id, title: state.buffer[id].fields.title }));
    return { revision: state.revision, bufferCount: bufferIds.length, bufferIds, bufferPreview, ...(actor ? { notices: unreadTaskNotices(state, actor), noticeVersion: state.notifications?.version || 0 } : {}) };
  }
  recoverPendingWorkflows() {
    return this.serial(async () => {
      const state = await this.read();
      const pending = Object.values(state.workflows).filter(workflow => workflow.status !== 'deleted' &&
        (workflow.ownerDeletion || workflow.completionRequest || workflow.edit || ['creating', 'approving'].includes(workflow.status) || workflow.reopenReceipt || workflow.sourceReopenReceipt) &&
        (workflow.syncRetryAt || 0) <= Date.now()).slice(0, 3);
      for (const workflow of pending) {
        // Persist backoff before network requests. Reloads and two open browsers
        // share the same retry schedule and the existing idempotent receipts.
        workflow.syncAttempts = (workflow.syncAttempts || 0) + 1;
        workflow.syncRetryAt = Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(workflow.syncAttempts, 6));
        await this.write(state);
        try {
          if (workflow.ownerDeletion) await this.deleteWorkflowTasks(state, workflow, workflow.ownerDeletion.id);
          else if (workflow.completionRequest) await this.completeByOwner(state, workflow, workflow.completionRequest.actor, workflow.completionRequest.id, workflow.completionRequest.signature);
          else if (workflow.edit) await this.finishWorkflowEdit(state, workflow);
          else if (workflow.status === 'creating') await this.startWorkflow(state, workflow);
          else if (workflow.status === 'approving') await this.finishApproval(state, workflow);
          else if (workflow.reopenReceipt || workflow.sourceReopenReceipt) {
            const sides = await this.workflowSides(state, workflow);
            await this.syncExternalCompletion(state, workflow, sides.source, sides.target);
          }
          if (!workflow.ownerDeletion && !workflow.completionRequest && !workflow.edit && !['creating', 'approving'].includes(workflow.status) && !workflow.reopenReceipt && !workflow.sourceReopenReceipt) {
            delete workflow.syncAttempts; delete workflow.syncRetryAt; await this.write(state);
          }
        } catch { /* A later authenticated poll retries using the persisted schedule. */ }
      }
    });
  }
  maintainWorkflows() {
    if (this.maintenance) return this.maintenance;
    if (Date.now() < this.maintenanceAfter) return Promise.resolve();
    const work = (async () => {
      await this.checkWorkflows();
      await this.recoverPendingWorkflows();
      await this.deliverNotices();
    })();
    this.maintenance = work.finally(() => { this.maintenance = undefined; this.maintenanceAfter = Date.now() + 15000; });
    return this.maintenance;
  }
  checkWorkflows() {
    return this.serial(async () => {
      const state = await this.read();
      if (!Object.values(state.workflows).some(workflow => !isPersonalCollection(workflow) && !workflow.ownerDeletion && ["working", "submitted", "rejected", "approving"].includes(workflow.status))) return;
      const { inboxes, inboxProjects } = await this.readInboxes();
      await this.checkWorkflowTasks(state, inboxes, inboxProjects);
    });
  }
  markNoticesRead(actor: string, ids: unknown) {
    return this.serial(async () => {
      await this.requireMember(actor);
      if (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== "string" || id.length > 200)) throw new CollaborationError("浏览记录参数无效", 400);
      const state = await this.read(), notices = initializeTaskNotices(state), allowed = new Set(notices.entries.filter(item => receivesTaskNotice(item, actor)).map(item => item.id));
      const before = notices.read[actor] || [], next = [...new Set([...before, ...ids.filter(id => allowed.has(id))])];
      if (next.length !== before.length) { notices.read[actor] = next; notices.version = (notices.version || 0) + 1; await this.write(state); }
      return { notices: unreadTaskNotices(state, actor), noticeVersion: notices.version || 0 };
    });
  }
  async deliverNotices() {
    if (!this.gateway.notify) return;
    const items = await this.serial(async () => {
      const state = await this.read(), notices = initializeTaskNotices(state), sent = new Set(notices.attempted);
      const pending = notices.entries.filter(item => !sent.has(item.id) && !silentWorkflowEvent(item.eventType)).slice(0, 40);
      if (pending.length) { notices.attempted.push(...pending.map(item => item.id)); await this.write(state); }
      return pending;
    });
    // Persist attempt before network I/O: refreshes and lost provider responses
    // do not repeatedly ring phones. The durable in-app unread record remains.
    for (let start = 0; start < items.length; start += 3) await Promise.allSettled(items.slice(start, start + 3).map(item => this.gateway.notify!(item)));
  }
  inspectTransfer(actorId: string, id: string) {
    return this.serial(async () => {
      if (!/^[a-f0-9-]{36}$/i.test(id)) throw new CollaborationError("操作编号无效", 400);
      if (!(await this.gateway.members()).some(member => member.id === actorId)) throw new CollaborationError("成员不存在", 403);
      const state = await this.read(), op = state.operations[id];
      if (!op) throw new CollaborationError("操作不存在", 404);
      if (op.action !== "move") throw new CollaborationError("此操作不是任务转移", 422);
      if (op.status !== "pending") return { status: op.status, message: op.status === "done" ? "该转移已完成，请刷新任务板。" : "该转移已取消，请刷新任务板。" };
      const source = await this.source(state, op.source!);
      const target = op.to ? await this.gateway.get(op.to, op.targetId) : state.buffer[op.targetId]?.fields || null;
      const sourceUnchanged = !!source && source.version === op.source!.version;
      const destinationCompleted = !!(target && "status" in target && target.status);
      const differences = target ? fieldDifferences(target, op.fields) : [];
      const candidates = !target ? await this.candidates(state, op) : [];
      const sourceMessage = !source ? "本次未读到原任务。" : sourceUnchanged ? "原任务仍在原处，内容与转移开始时一致。" : "原任务仍在原处，但已发生变化。";
      const targetMessage = !target ? "本次未读到接收方副本，尚不能确认是否创建成功。" : destinationCompleted ? "接收方副本已完成或状态改变。" : differences.length ? `接收方副本与转移记录不一致的项目：${differences.join("、")}。` : "接收方副本已读到，任务内容核对一致。";
      return { status: op.status, phase: op.phase, sourceExists: !!source, sourceUnchanged, destinationExists: !!target, destinationCompleted, differences, candidates: candidates.map(task => ({ id: task.id, version: remoteVersion(task) })), message: `${sourceMessage}${targetMessage}${candidates.length ? `接收方另有 ${candidates.length} 项完整内容一致的任务，旧记录无法仅凭内容确定这些任务的来源。` : ""}本次核对只读取状态，没有继续或取消转移。` };
    });
  }
  private async readInboxes(memberId?: string | null) {
    const allMembers = await this.gateway.members();
    if (typeof memberId === 'string' && !allMembers.some(member => member.id === memberId)) throw new CollaborationError("成员不存在", 404);
    const members = typeof memberId === 'string' ? allMembers.filter(member => member.id === memberId) : allMembers;
    const inboxes = new Map<string, RemoteTask[]>();
    const inboxProjects = new Map<string, string>();
    const results: CollaborationSnapshot["members"] = [];
    for (let index = 0; index < members.length; index += 3) results.push(...await Promise.all(members.slice(index, index + 3).map(async member => {
      try {
        if (!member.connected) return { ...member, tasks: [], error: "尚未连接滴答清单" };
        if (memberId === null) return { ...member, tasks: [], loading: true };
        const inbox = await this.gateway.inbox(member.id);
        inboxes.set(member.id, inbox.tasks);
        inboxProjects.set(member.id, inbox.projectId);
        const parents = new Set(inbox.tasks.map(task => task.parentId).filter(Boolean));
        return { ...member, tasks: inbox.tasks.filter(task => !task.status).map(task => ({ ...taskFields(task), id: task.id, ownerId: member.id, version: remoteVersion(task), transferBlocked: task.parentId || parents.has(task.id) ? "含父子任务关系，请先在滴答中整理关系后认领" : undefined })) };
      } catch (error) { return { ...member, tasks: [], error: error instanceof Error ? error.message : "收集箱暂时无法读取", ...(error instanceof CollaborationError && error.diagnostic ? { diagnostic: error.diagnostic } : {}) }; }
    })));
    return { results, inboxes, inboxProjects };
  }
  async snapshot(identityId: string, memberId?: string | null): Promise<CollaborationSnapshot> {
    // Atomic state reads and inbox display must not wait behind remote writes
    // or workflow searches. Reconciliation runs after the HTTP response.
    const { results, inboxes } = await this.readInboxes(memberId);
    const state = await this.read();
    const pending = Object.values(state.operations).filter(op => op.status === "pending");
    const lock = (task: RoomTask) => {
      const workflow = this.taskWorkflow(state, task.ownerId, task.id), collecting = workflow && isPersonalCollection(workflow);
      return { ...task, workflowId: !collecting ? workflow?.id : undefined, pending: collecting ? workflow.id : pending.find(op => (op.source?.ownerId === task.ownerId && op.source.taskId === task.id) || (op.to === task.ownerId && op.targetId === task.id))?.id };
    };
    return {
      identityId, revision: state.revision, executionVersion: state.executionPlans?.[identityId]?.version || 0,
      notices: unreadTaskNotices(state, identityId),
      noticeVersion: state.notifications?.version || 0,
      buffer: Object.entries(state.buffer).filter(([, task]) => !task.completedAt).map(([id, task]) => lock({ ...task.fields, id, ownerId: null, version: String(task.version), publisherId: task.publisherId })),
      members: results.map(member => ({ ...member, tasks: (inboxes.get(member.id) || []).filter(task => !task.status).map(task => lock({ ...taskFields(task), id: task.id, ownerId: member.id, version: remoteVersion(task), transferBlocked: member.tasks.find(item => item.id === task.id)?.transferBlocked })) })),
      operations: [...Object.values(state.operations).map(op => this.publicOperation(op)), ...Object.values(state.workflows).filter(isPersonalCollection).map(workflow => collectionOperation(this.publicWorkflow(workflow)))].sort((a, b) => b.updatedAt - a.updatedAt).filter((op, index) => op.status === "pending" || index < 30),
      workflows: Object.values(state.workflows).filter(workflow => !isPersonalCollection(workflow)).sort((a, b) => b.updatedAt - a.updatedAt).map(workflow => this.publicWorkflow(workflow)),
      legacyCleanup: state.legacyCleanup || [],
    };
  }
  private sideReference(workflow: Workflow, side: WorkflowSide) {
    return side === "source"
      ? { owner: workflow.reviewerId, id: workflow.source.ownerId ? workflow.source.taskId : workflow.reviewerTaskId! }
      : { owner: workflow.claimantId, id: workflow.targetId };
  }
  private async linkedTask(state: State, workflow: Workflow, side: WorkflowSide, inbox?: RemoteTask[]) {
    const { owner, id } = this.sideReference(workflow, side);
    if (!id) return null;
    const task = inbox?.find(item => item.id === id) ?? await (this.gateway.locate
      ? this.gateway.locate(owner, id, workflow.projects?.[side], this.completedAfter(state, workflow))
      : this.gateway.get(owner, id, workflow.projects?.[side]));
    if (task && workflow.projects?.[side] !== task.projectId) {
      workflow.projects ||= {}; workflow.projects[side] = task.projectId;
      await this.saveWorkflow(state, workflow);
    }
    return task;
  }
  private completedAfter(state: State, workflow: Workflow) {
    workflow.publishedAt ??= (workflow.source.ownerId === null
      ? state.buffer[workflow.source.taskId]?.publishedAt ?? Object.values(state.operations).find(op => op.action === "create" && op.targetId === workflow.source.taskId)?.createdAt
      : undefined) ?? workflow.createdAt;
    // Publication is a website date, independent of the task's planned dates.
    const day = 86400000, shanghaiOffset = 8 * 3600000;
    return Math.floor((workflow.publishedAt + shanghaiOffset) / day) * day - shanghaiOffset;
  }
  private async checkWorkflowTasks(state: State, inboxes: Map<string, RemoteTask[]>, inboxProjects: Map<string, string>) {
    for (const workflow of Object.values(state.workflows)) {
      if (isPersonalCollection(workflow) || workflow.ownerDeletion || !["working", "submitted", "rejected", "approving"].includes(workflow.status)) continue;
      const before = workflow.syncError;
      try {
        // A failed account read is not evidence of a missing task. Do not perform
        // fallback searches or recovery writes using an unavailable account.
        if ((this.sideReference(workflow, "source").id && !inboxes.has(workflow.reviewerId)) || !inboxes.has(workflow.claimantId)) throw new CollaborationError("关联账户暂时无法读取，请重试或重新连接滴答");
        const source = await this.linkedTask(state, workflow, "source", inboxes.get(workflow.reviewerId));
        const target = await this.linkedTask(state, workflow, "target", inboxes.get(workflow.claimantId));
        if (!target || (workflow.source.ownerId && !source)) await this.markMissingWorkflowTask(state, workflow);
        else {
          const synced = await this.syncExternalCompletion(state, workflow, source, target);
          if (workflow.taskAnomaly && !workflow.recovery) { workflow.taskAnomaly = false; workflow.error = ""; await this.saveWorkflow(state, workflow); }
          // Reflect this refresh's writes without another full inbox request.
          for (const side of ["source", "target"] as const) {
            const task = synced[side], owner = this.sideReference(workflow, side).owner;
            if (!task) continue;
            const list = inboxes.get(owner)!;
            const index = list.findIndex(item => item.id === task.id);
            if (index >= 0) list[index] = task;
            else if (!task.status && inboxProjects.get(owner) === task.projectId) list.push(task);
          }
        }
        workflow.syncError = undefined;
      } catch (error) { workflow.syncError = error instanceof Error ? error.message : "任务状态暂时无法读取，请重试"; }
      if (before !== workflow.syncError) await this.saveWorkflow(state, workflow);
    }
  }
  private async markMissingWorkflowTask(state: State, workflow: Workflow) {
    if (!workflow.taskAnomaly) { workflow.taskAnomaly = true; workflow.missingGeneration = (workflow.missingGeneration || 0) + 1; await this.saveWorkflow(state, workflow); }
  }
  private async syncExternalCompletion(state: State, workflow: Workflow, source: RemoteTask | null, target: RemoteTask, force = false, completing = false) {
    if (workflow.recovery || workflow.completionRequest || workflow.status === "done" || workflow.status === "approving" || completing) return { source, target };
    // Never rewind or complete a later occurrence based on an older workflow.
    if (workflow.fields.repeatFlag && [source, target].some(task => task && (taskFields(task).startDate !== workflow.fields.startDate || taskFields(task).dueDate !== workflow.fields.dueDate))) throw new CollaborationError("重复任务日期已变化，暂不自动操作下一次任务，请在滴答检查本次完成记录");
    const tasks = { source, target };
    for (const side of ["source", "target"] as const) {
      const task = tasks[side], key = side === "source" ? "sourceReopenReceipt" : "reopenReceipt";
      if (!task || !task.status) {
        if (workflow[key]) { delete workflow[key]; workflow.reopenPending = !!(workflow.reopenReceipt || workflow.sourceReopenReceipt); await this.saveWorkflow(state, workflow); }
        continue;
      }
      if (task.status !== 2) throw new CollaborationError("关联任务状态暂不支持同步，请检查滴答");
      // The website remains authoritative for both sides. Preserve the current
      // task fields, submission and stage; status repairs create no user events.
      if (!workflow[key] || remoteVersion(workflow[key]!.before) !== remoteVersion(task)) {
        workflow[key] = { before: task, retryAt: 0 }; workflow.reopenPending = true;
        await this.saveWorkflow(state, workflow);
      }
      const receipt = workflow[key]!;
      if (!force && receipt.retryAt > Date.now()) throw new CollaborationError("恢复未完成状态暂未确认，将稍后重试");
      receipt.retryAt = Date.now() + 60000; await this.saveWorkflow(state, workflow);
      const restored = await this.gateway.reopen(this.sideReference(workflow, side).owner, receipt.before, this.completedAfter(state, workflow));
      if (restored.id !== task.id || restored.projectId !== receipt.before.projectId || restored.status || !sameFields(restored, receipt.before)) throw new CollaborationError("恢复结果与关联任务不符，请检查滴答后重试");
      if (workflow.submitted && sameFields(restored, workflow.submittedFields?.[side] || workflow.fields)) workflow.submitted[side] = remoteVersion(restored);
      tasks[side] = restored; delete workflow[key];
      workflow.reopenPending = !!(workflow.reopenReceipt || workflow.sourceReopenReceipt);
      workflow.syncError = undefined; workflow.needsSubmission = false;
      await this.saveWorkflow(state, workflow);
    }
    if (workflow.needsSubmission) { workflow.needsSubmission = false; await this.saveWorkflow(state, workflow); }
    if (workflow.syncError) { workflow.syncError = undefined; await this.saveWorkflow(state, workflow); }
    return tasks;
  }
  private async restoreWorkflow(state: State, workflow: Workflow) {
    try {
      // Read both accounts before the first creation. Network and authorization
      // failures must never turn into a replacement task.
      if (this.sideReference(workflow, "source").id) await this.gateway.inbox(workflow.reviewerId);
      await this.gateway.inbox(workflow.claimantId);
      const tasks = { source: await this.linkedTask(state, workflow, "source"), target: await this.linkedTask(state, workflow, "target") };
      workflow.recovery ||= {};
      for (const side of ["source", "target"] as const) {
        // An absent publisher task is optional, including during explicit recovery.
        if (side === "source" && !tasks.source && !workflow.source.ownerId) continue;
        const { owner } = this.sideReference(workflow, side);
        let recovery = workflow.recovery[side];
        if (tasks[side] && !recovery) continue;
        if (recovery?.done) {
          if (!tasks[side]) throw new CollaborationError("已恢复的任务再次缺失，请刷新后检查；本次不重复创建");
          continue;
        }
        // If the old task reappears before a request was sent, retain it.
        if (tasks[side] && recovery?.creation.state === "new") { delete workflow.recovery[side]; continue; }
        if (!recovery) {
          recovery = { id: randomBytes(12).toString("hex"), creation: { state: "new" } };
          workflow.recovery[side] = recovery; await this.saveWorkflow(state, workflow);
        }
        const fields = workflow.edit?.fields || workflow.fields;
        const receipt = async (id: string) => {
          if (recovery.creation.beforeIds?.includes(id)) throw new CollaborationError("恢复响应指向原有任务，已停止替换关联");
          recovery.id = id; recovery.creation.state = "received"; await this.saveWorkflow(state, workflow);
        };
        let task = await this.gateway.get(owner, recovery.id);
        if (!task && recovery.creation.state === "new") {
          recovery.creation.beforeIds = (await this.gateway.inbox(owner)).tasks.map(item => item.id);
          recovery.creation.state = "sent"; await this.saveWorkflow(state, workflow);
          await this.gateway.create(owner, recovery.id, fields, receipt);
          task = await this.gateway.get(owner, recovery.id);
        } else if (!task && recovery.creation.state === "sent") {
          const candidates = (await this.gateway.inbox(owner)).tasks.filter(item => !item.status && !recovery.creation.beforeIds?.includes(item.id) && sameFields(item, fields) && !this.taskWorkflow(state, owner, item.id));
          if (candidates.length !== 1) throw new CollaborationError("恢复请求结果未确定，已停止重复创建，请稍后重试");
          await receipt(candidates[0].id); task = await this.gateway.get(owner, recovery.id);
        }
        if (!task || task.status || !sameFields(task, fields)) throw new CollaborationError("恢复任务尚未通过核对，请稍后重试");
        if (tasks[side] && tasks[side]!.id !== task.id) throw new CollaborationError("原任务重新出现，已暂停关联替换，请检查滴答中的任务");
        if (side === "target") { workflow.targetId = task.id; delete workflow.reopenReceipt; workflow.reopenPending = false; }
        else if (workflow.source.ownerId) { workflow.source.taskId = task.id; workflow.source.version = remoteVersion(task); }
        else workflow.reviewerTaskId = task.id;
        workflow.projects ||= {}; workflow.projects[side] = task.projectId;
        // Only the replaced side gets a new approval fingerprint. A surviving
        // task edited externally still fails the existing approval edit guard.
        if (workflow.submitted) workflow.submitted[side] = remoteVersion(task);
        if (workflow.approval) {
          workflow.approval[side === "source" ? "sourceDone" : "targetDone"] = false;
          workflow.approval[side === "source" ? "sourceSent" : "targetSent"] = false;
        }
        if (workflow.edit) delete workflow.edit.targets;
        recovery.done = true; await this.saveWorkflow(state, workflow);
      }
      delete workflow.recovery; workflow.taskAnomaly = false; workflow.syncError = undefined;
      workflow.events.push({ id: randomUUID(), actorId: "", type: "tasks-restored", at: Date.now(), comment: "关联任务已恢复，保留原流程状态与提交材料", files: [] });
    } catch (error) { workflow.syncError = error instanceof Error ? error.message : "任务恢复尚未完成，请重试"; }
    await this.saveWorkflow(state, workflow); return this.publicWorkflow(workflow);
  }
  private taskWorkflow(state: State, owner: string | null, id: string) {
    return Object.values(state.workflows).find(workflow => !["done", "deleted"].includes(workflow.status) && (
      (workflow.source.ownerId === owner && workflow.source.taskId === id) ||
      (workflow.claimantId === owner && workflow.targetId === id) ||
      (workflow.reviewerId === owner && workflow.reviewerTaskId === id)
    ));
  }
  private publicWorkflow(workflow: Workflow): ClaimWorkflow {
    const { id, title, source, reviewerId, claimantId, targetId, reviewerTaskId, fields, status, version, createdAt, updatedAt, error, events } = workflow;
    return { id, title, source, reviewerId, claimantId, targetId, reviewerTaskId, fields: workflow.edit?.fields || fields, status, version, createdAt, updatedAt, error, executing: !!workflow.executing, editPending: !!workflow.edit, ownerDeletePending: !!workflow.ownerDeletion, taskAnomaly: workflow.taskAnomaly, syncError: workflow.syncError, reopenPending: workflow.reopenPending, needsSubmission: workflow.needsSubmission, events: events.map(({ id, actorId, type, at, comment, files, replyTo }) => ({ id, actorId, type, at, comment, files, replyTo })) };
  }
  private async saveWorkflow(state: State, workflow: Workflow) {
    if (workflow.executing && (['done', 'deleted'].includes(workflow.status) || workflow.ownerDeletion)) {
      workflow.executing = false;
      state.executionPlans ||= {};
      const plan = state.executionPlans[workflow.claimantId] ||= { version: 0, receipts: [] };
      plan.version++;
    }
    workflow.updatedAt = Date.now(); workflow.version++; state.revision++; await this.write(state);
  }
  arrangeExecution(actor: string, command: ExecutionCommand) {
    return this.serial(async () => {
      await this.requireMember(actor);
      if (!command || command.action !== 'arrange-execution' || !/^[a-f0-9-]{36}$/i.test(command.id) || !Number.isSafeInteger(command.version) || command.version < 0 || !Array.isArray(command.workflowIds) || command.workflowIds.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) || new Set(command.workflowIds).size !== command.workflowIds.length) throw new CollaborationError('执行安排参数无效', 400);
      if (command.workflowIds.length > EXECUTION_LIMIT) throw new CollaborationError('执行中任务最多3个', 400);
      const state = await this.read(), signature = fingerprint({ actor, command });
      state.executionPlans ||= {};
      const plan = state.executionPlans[actor] ||= { version: 0, receipts: [] };
      const response = () => ({ execution: { id: command.id, version: plan.version }, revision: state.revision, workflows: Object.values(state.workflows).filter(workflow => workflow.claimantId === actor && !isPersonalCollection(workflow)).map(workflow => this.publicWorkflow(workflow)) });
      const prior = plan.receipts.find(receipt => receipt.id === command.id);
      if (prior) { if (prior.signature !== signature) throw new CollaborationError('操作编号已使用'); return response(); }
      if (plan.version !== command.version) throw new CollaborationError('执行安排已更新，请重新安排后保存');
      const reserved = Object.values(state.workflows).filter(workflow => workflow.claimantId === actor && !isPersonalCollection(workflow) && executionReserved(this.publicWorkflow(workflow)));
      if (reserved.some(workflow => !command.workflowIds.includes(workflow.id))) throw new CollaborationError('待审批任务仍占用执行名额');
      for (const id of command.workflowIds) {
        const workflow = state.workflows[id];
        if (!workflow || workflow.claimantId !== actor || isPersonalCollection(workflow)) throw new CollaborationError('只能安排自己认领的任务', 403);
        if (!executionEligible(this.publicWorkflow(workflow)) && !executionReserved(this.publicWorkflow(workflow))) throw new CollaborationError('任务状态已变化，请重新安排后保存');
      }
      const selected = new Set(command.workflowIds), now = Date.now();
      for (const workflow of Object.values(state.workflows).filter(workflow => workflow.claimantId === actor && !isPersonalCollection(workflow))) {
        const executing = selected.has(workflow.id);
        if (!!workflow.executing === executing) continue;
        workflow.executing = executing; workflow.version++; workflow.updatedAt = now;
      }
      plan.version++; plan.receipts = [...plan.receipts, { id: command.id, signature }].slice(-30);
      state.revision++; await this.write(state);
      return response();
    });
  }
  private async requireMember(actor: string) {
    const members = await this.gateway.members();
    if (!members.some(member => member.id === actor)) throw new CollaborationError("成员不存在", 403);
    return members;
  }
  private async ensureWorkflowTask(state: State, workflow: Workflow, reviewer = false, completing = false) {
    const owner = reviewer ? workflow.reviewerId : workflow.claimantId;
    const creation = reviewer ? workflow.reviewerCreation! : workflow.targetCreation;
    const id = reviewer ? workflow.reviewerTaskId! : workflow.targetId;
    const side = reviewer ? "source" : "target";
    const read = (taskId: string) => creation.state !== "new" && this.gateway.locate
      ? this.gateway.locate(owner, taskId, workflow.projects?.[side], this.completedAfter(state, workflow))
      : this.gateway.get(owner, taskId, workflow.projects?.[side]);
    let task = await read(id);
    const remember = async (actualId: string) => {
      if (creation.beforeIds?.includes(actualId)) throw new CollaborationError("创建响应指向原有任务，暂不能建立认领");
      if (reviewer) workflow.reviewerTaskId = actualId; else workflow.targetId = actualId;
      creation.state = "received"; await this.saveWorkflow(state, workflow);
    };
    if (!task && creation.state === "new") {
      creation.beforeIds = (await this.gateway.inbox(owner)).tasks.map(item => item.id);
      creation.state = "sent"; await this.saveWorkflow(state, workflow);
      await this.gateway.create(owner, id, workflow.fields, remember);
      task = await read(reviewer ? workflow.reviewerTaskId! : workflow.targetId);
    } else if (!task && creation.state === "sent") {
      const matches = (await this.gateway.inbox(owner)).tasks.filter(item => !creation.beforeIds?.includes(item.id) && !item.status && sameFields(item, workflow.fields) && !this.taskWorkflow(state, owner, item.id));
      if (matches.length !== 1) throw new CollaborationError("创建结果暂未确定，已停止重复创建，请稍后重试");
      await remember(matches[0].id); task = await read(matches[0].id);
    }
    if (!task && creation.state === "received") { await this.markMissingWorkflowTask(state, workflow); throw new CollaborationError("该任务已被删除"); }
    if (!task || (task.status && task.status !== 2) || !sameFields(task, workflow.fields)) throw new CollaborationError(verificationIssue(task, workflow.fields));
    workflow.projects ||= {}; workflow.projects[side] = task.projectId;
    if (!reviewer && task.status === 2 && !completing && !isPersonalCollection(workflow)) await this.syncExternalCompletion(state, workflow, null, task, true);
    workflow.taskAnomaly = false;
  }
  private async startWorkflow(state: State, workflow: Workflow, completing = false) {
    if (workflow.ownerDeletion) return this.publicWorkflow(workflow);
    try {
      // Public claims create only the claimant's task. Existing publisher links
      // remain readable, but never create a publisher task just for synchronization.
      await this.ensureWorkflowTask(state, workflow, false, completing);
      if (workflow.source.ownerId === null && workflow.reviewerId === workflow.claimantId) workflow.reviewerTaskId = workflow.targetId;
      if (isPersonalCollection(workflow) && !workflow.edit) {
        // This receipt only makes creation retryable; no approval or completion occurs.
        delete state.buffer[workflow.source.taskId];
        workflow.status = "done";
      } else workflow.status = "working";
      workflow.error = "";
    } catch (error) { workflow.error = error instanceof Error ? error.message : "认领任务暂未建立，请重试"; }
    await this.saveWorkflow(state, workflow); return this.publicWorkflow(workflow);
  }
  private async fieldsAfterTask(state: State, fields: TaskFields, after: TaskSource | undefined, owner: string | null, source: TaskSource): Promise<TaskFields> {
    if (after === undefined) return fields;
    if (!after || after.ownerId !== owner || !owner || typeof after.taskId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(after.taskId) || typeof after.version !== "string" || (after.ownerId === source.ownerId && after.taskId === source.taskId)) throw new CollaborationError("日期参照任务无效", 400);
    const previous = await this.source(state, after);
    if (!previous || previous.remote?.status || previous.version !== after.version || !collaborationDate(previous.fields)) throw new CollaborationError("前一条待办已变化，请刷新后重新拖动");
    return { ...fields, ...collaborationDateAfter(fields, previous.fields) };
  }
  claim(actor: string, command: CollaborationCommand) {
    return this.serial(async () => {
      const members = await this.requireMember(actor), source = command.source;
      if (!/^[a-f0-9-]{36}$/i.test(command.id) || command.action !== "claim" || !source || typeof source.taskId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(source.taskId) || typeof source.version !== "string") throw new CollaborationError("认领参数无效", 400);
      const claimant = command.destination || actor;
      if (!members.some(member => member.id === claimant && member.connected) || (source.ownerId !== null && !members.some(member => member.id === source.ownerId))) throw new CollaborationError("认领者或任务来源不可用", 422);
      if (source.ownerId === claimant) throw new CollaborationError("任务已经在此账号中", 400);
      const state = await this.read(), signature = fingerprint({ actor, command }), existing = state.workflows[command.id];
      if (existing) {
        if (existing.signature !== signature) throw new CollaborationError("操作编号已使用");
        if (isPersonalCollection(existing)) return this.finishCollection(state, existing);
        if (existing.edit) return this.finishWorkflowEdit(state, existing);
        return existing.status === "creating" ? this.startWorkflow(state, existing) : this.publicWorkflow(existing);
      }
      if (this.taskWorkflow(state, source.ownerId, source.taskId)) throw new CollaborationError("此任务已经有人认领");
      if (Object.values(state.operations).some(op => op.status === "pending" && ((op.source?.ownerId === source.ownerId && op.source.taskId === source.taskId) || (op.to === source.ownerId && op.targetId === source.taskId)))) throw new CollaborationError("请先清理此任务的旧记录");
      const current = await this.source(state, source);
      if (!current || current.remote?.status || current.version !== source.version || (source.ownerId === null && state.buffer[source.taskId]?.completedAt)) throw new CollaborationError("任务已变化，请刷新后认领");
      const reviewer = source.ownerId || state.buffer[source.taskId]?.publisherId;
      if (!reviewer || !members.some(member => member.id === reviewer && member.connected)) throw new CollaborationError("任务发布者需要先连接滴答清单", 422);
      const targetInbox = await this.gateway.inbox(claimant);
      if (targetInbox.projectId === "inbox") throw new CollaborationError("暂不能识别认领者收集箱，请先添加一项任务后刷新", 422);
      if (source.ownerId && current.remote) {
        if (current.remote.parentId || (await this.gateway.inbox(source.ownerId)).tasks.some(task => task.parentId === current.remote!.id)) throw new CollaborationError("含父子任务关系，暂不能单独认领", 422);
        if (current.remote.projectId === targetInbox.projectId) throw new CollaborationError("两位成员连接了同一个滴答收集箱", 422);
      } else {
        const reviewerInbox = await this.gateway.inbox(reviewer);
        if (reviewerInbox.projectId === "inbox") throw new CollaborationError("暂不能识别发布者收集箱", 422);
        if (reviewer !== claimant && reviewerInbox.projectId === targetInbox.projectId) throw new CollaborationError("两位成员连接了同一个滴答收集箱", 422);
      }
      const fields = await this.fieldsAfterTask(state, current.fields, command.dateAfter, claimant, source);
      const now = Date.now();
      const workflow: Workflow = { id: command.id, signature, title: current.fields.title, source: { ...source }, reviewerId: reviewer, claimantId: claimant, targetId: randomBytes(12).toString("hex"), fields: current.fields, status: "creating", version: 0, createdAt: now, updatedAt: now, error: "", targetCreation: { state: "new" }, events: [{ id: command.id, actorId: actor, type: "claimed", at: now, comment: "", files: [] }] };
      if (!sameFields(fields, current.fields)) {
        const editId = randomUUID();
        workflow.edit = { id: editId, fields };
        workflow.events.push({ id: editId, actorId: actor, type: "updating", at: now, comment: "", files: [] });
      }
      workflow.projects = { target: targetInbox.projectId, ...(current.remote ? { source: current.remote.projectId } : {}) };
      this.completedAfter(state, workflow);
      state.workflows[workflow.id] = workflow; await this.saveWorkflow(state, workflow);
      if (isPersonalCollection(workflow)) return this.finishCollection(state, workflow);
      if (workflow.edit) return this.finishWorkflowEdit(state, workflow);
      return this.startWorkflow(state, workflow);
    });
  }
  private async finishCollection(state: State, workflow: Workflow) {
    if (workflow.edit) { await this.finishWorkflowEdit(state, workflow); if (workflow.edit) return this.publicWorkflow(workflow); }
    if (workflow.status === "approving") { const result = await this.finishApproval(state, workflow); if (result.status !== "done") return result; }
    if (workflow.status === "creating") return this.startWorkflow(state, workflow);
    if (state.buffer[workflow.source.taskId] || workflow.status !== "done") {
      delete state.buffer[workflow.source.taskId]; workflow.status = "done"; workflow.error = "";
      await this.saveWorkflow(state, workflow);
    }
    return this.publicWorkflow(workflow);
  }
  private async workflowSides(state: State, workflow: Workflow) {
    const source = await this.linkedTask(state, workflow, "source");
    const target = workflow.claimantId === workflow.reviewerId && workflow.targetId === workflow.reviewerTaskId
      ? source : await this.linkedTask(state, workflow, "target");
    if (!target || (workflow.source.ownerId && !source)) { await this.markMissingWorkflowTask(state, workflow); throw new CollaborationError("该任务已被删除"); }
    if (workflow.taskAnomaly && !workflow.recovery) { workflow.taskAnomaly = false; workflow.error = ""; await this.saveWorkflow(state, workflow); }
    return { source, target };
  }
  private async finishApproval(state: State, workflow: Workflow) {
    const approval = workflow.approval!;
    try {
      for (const side of ["source", "target"] as const) {
        const key = side === "source" ? "sourceDone" : "targetDone";
        if (approval[key]) continue;
        const owner = side === "source" ? workflow.reviewerId : workflow.claimantId;
        const id = side === "source" ? workflow.source.ownerId ? workflow.source.taskId : workflow.reviewerTaskId! : workflow.targetId;
        const task = await this.linkedTask(state, workflow, side);
        if (!task && side === "source" && !workflow.source.ownerId) { approval.sourceDone = true; await this.saveWorkflow(state, workflow); continue; }
        if (!task) { await this.markMissingWorkflowTask(state, workflow); throw new CollaborationError("该任务已被删除"); }
        if (task.status !== 2) {
          if (task.status) throw new CollaborationError("关联任务状态暂不支持完成，请检查滴答后重试");
          if (workflow.fields.repeatFlag && (taskFields(task).startDate !== workflow.fields.startDate || taskFields(task).dueDate !== workflow.fields.dueDate)) throw new CollaborationError("重复任务日期已变化，暂不自动操作下一次任务，请在滴答检查本次完成记录");
          const sent = side === "source" ? "sourceSent" : "targetSent";
          if (approval[sent] && (approval.repeating || workflow.fields.repeatFlag)) throw new CollaborationError("重复任务的完成响应未确认，已停止重复勾选，请核对滴答中的本次任务");
          approval.repeating ||= !!(workflow.fields.repeatFlag || task.repeatFlag);
          // Complete the current linked task. Keep its receipt for retries and
          // later checkbox requests without requiring a new submission.
          workflow.submitted ||= { source: "", target: "" };
          workflow.submitted[side] = remoteVersion(task);
          approval[sent] = true; await this.saveWorkflow(state, workflow);
          await this.gateway.complete(owner, id, workflow.projects?.[side]);
        }
        approval[key] = true;
        if (workflow.claimantId === workflow.reviewerId && workflow.targetId === workflow.reviewerTaskId) approval.targetDone = true;
        await this.saveWorkflow(state, workflow);
      }
      if (workflow.source.ownerId === null && state.buffer[workflow.source.taskId]) state.buffer[workflow.source.taskId].completedAt = Date.now();
      workflow.status = "done"; workflow.error = "";
      delete workflow.reopenReceipt; delete workflow.sourceReopenReceipt; workflow.reopenPending = false; workflow.needsSubmission = false;
      workflow.taskAnomaly = false; workflow.syncError = undefined;
      workflow.events.push({ id: randomUUID(), actorId: workflow.reviewerId, type: "completed", at: Date.now(), comment: "已有的关联任务已完成，缺省的发起者任务跳过", files: [] });
    } catch (error) { workflow.error = error instanceof Error ? error.message : "完成状态尚未同步，请重试"; }
    await this.saveWorkflow(state, workflow); return this.publicWorkflow(workflow);
  }
  private async finishWorkflowEdit(state: State, workflow: Workflow, completing = false) {
    const edit = workflow.edit!;
    try {
      if (edit.attachments) await this.gateway.taskAttachments?.publish(edit.attachments.actor, edit.attachments.publishBefore ?? edit.attachments.before, edit.attachments.after);
      if (workflow.status === "creating") {
        await this.startWorkflow(state, workflow, completing);
        if (workflow.status === "creating") return this.publicWorkflow(workflow);
      }
      if (!edit.targets) {
        const sides = await this.workflowSides(state, workflow);
        edit.targets = sides.source ? [{ owner: workflow.reviewerId, id: sides.source.id, before: remoteVersion(sides.source), done: false }] : [];
        if (workflow.claimantId !== workflow.reviewerId || workflow.targetId !== edit.targets[0]?.id) edit.targets.push({ owner: workflow.claimantId, id: workflow.targetId, before: remoteVersion(sides.target), done: false });
        await this.saveWorkflow(state, workflow);
      }
      for (const target of edit.targets) {
        if (target.done) continue;
        const side = target.owner === workflow.reviewerId ? "source" : "target";
        const task = await this.linkedTask(state, workflow, side);
        if (!task && side === "source") { target.done = true; await this.saveWorkflow(state, workflow); continue; }
        if (!task) { await this.markMissingWorkflowTask(state, workflow); throw new CollaborationError("该任务已被删除"); }
        if (!sameFields(task, edit.fields)) {
          if (remoteVersion(task) !== target.before) throw new CollaborationError("关联任务在同步期间被修改，已暂停覆盖，请核对后重试");
          await this.gateway.update(target.owner, target.id, edit.fields, target.before, workflow.projects?.[side]);
        }
        target.done = true; await this.saveWorkflow(state, workflow);
      }
      const sides = await this.workflowSides(state, workflow);
      if ((sides.source && !sameFields(sides.source, edit.fields)) || !sameFields(sides.target, edit.fields)) throw new CollaborationError("关联任务详情暂未一致，请核对后重试");
      if (workflow.source.ownerId === null && state.buffer[workflow.source.taskId]) {
        const task = state.buffer[workflow.source.taskId];
        task.fields = edit.fields; task.version++;
      }
      if (workflow.approval) workflow.approval.repeating ||= !!workflow.fields.repeatFlag;
      workflow.fields = edit.fields; workflow.title = edit.fields.title;
      // Editing task details preserves pending review. Only an explicit reject
      // asks the claimant to submit again.
      if (workflow.reopenReceipt) {
        if (sides.target.status === 2) workflow.reopenReceipt = { before: sides.target, retryAt: 0 };
        else if (!sides.target.status) { delete workflow.reopenReceipt; workflow.reopenPending = false; }
      }
      // Explicit edits during partially completed approval update the expected fields,
      // but preserve acknowledged/sent completion markers, including repeating tasks.
      if (workflow.status === "approving") workflow.submitted = { source: sides.source ? remoteVersion(sides.source) : "", target: remoteVersion(sides.target) };
      const event = workflow.events.find(item => item.id === edit.id)!;
      if (edit.attachments) { await this.saveWorkflow(state, workflow); await this.cleanAttachments(state, edit.attachments); }
      event.type = "updated";
      event.comment = edit.summary || "旧记录未保存具体修改内容";
      delete workflow.edit; workflow.error = "";
    } catch (error) { workflow.error = error instanceof Error ? error.message : "任务详情尚未同步完成，请重试"; }
    await this.saveWorkflow(state, workflow); return this.publicWorkflow(workflow);
  }
  private async completeByOwner(state: State, workflow: Workflow, actor: string, id: string, signature: string, review?: ReviewDecision) {
    if (actor !== workflow.reviewerId) throw new CollaborationError("只有原任务所属成员或公共任务发布者能直接完成；认领者请提交审批", 403);
    if (workflow.ownerDeletion) throw new CollaborationError("发起任务的删除结果尚未确认，请核对并继续");
    if (workflow.status === "done" || workflow.status === "deleted") return this.publicWorkflow(workflow);
    if (workflow.status === "approving") return this.finishApproval(state, workflow);
    // Save the user's decision before lookup or creation verification can fail.
    // Missing tasks retain their current stage until the same ID is available.
    if (!workflow.completionRequest) { workflow.completionRequest = { id, actor, signature, ...(review ? { review } : {}) }; await this.saveWorkflow(state, workflow); }
    try {
      if (workflow.edit) { await this.finishWorkflowEdit(state, workflow, true); if (workflow.edit) return this.publicWorkflow(workflow); }
      if (workflow.status === "creating") { await this.startWorkflow(state, workflow, true); if (workflow.status === "creating") return this.publicWorkflow(workflow); }
      const sides = await this.workflowSides(state, workflow);
      if ([sides.source, sides.target].some(task => task?.status && task.status !== 2)) throw new CollaborationError("关联任务状态暂不支持完成，请刷新后重试");
      workflow.submitted = { source: sides.source ? remoteVersion(sides.source) : "", target: remoteVersion(sides.target) };
      workflow.approval = { sourceDone: !sides.source || sides.source.status === 2, targetDone: sides.target.status === 2 };
      if (workflow.status === 'submitted') workflow.executing = true;
      workflow.status = "approving"; workflow.error = "";
      const request = workflow.completionRequest;
      workflow.events.push({ id: request.id, signature: request.signature, actorId: request.actor, type: request.review ? "approve" : "owner-complete", at: Date.now(), comment: request.review?.comment ?? "原任务所属成员或发布者已直接标记完成，正在同步双方任务", files: request.review?.files || [] });
      delete workflow.completionRequest;
      await this.saveWorkflow(state, workflow);
      return this.finishApproval(state, workflow);
    } catch (error) {
      workflow.error = error instanceof Error ? error.message : "完成状态尚未同步，请重试";
      await this.saveWorkflow(state, workflow); return this.publicWorkflow(workflow);
    }
  }
  private async deleteWorkflowTasks(state: State, workflow: Workflow, eventId: string) {
    const event = workflow.events.find(item => item.id === eventId)!;
    // Completed requests from the old one-sided deletion behavior are receipts,
    // not authorization to apply the new behavior retroactively.
    if (["owner-task-deleted", "claimant-task-deleted", "task-deleted"].includes(event.type) || workflow.status === 'deleted') {
      if (workflow.ownerDeletion?.id === eventId) {
        delete workflow.ownerDeletion;
        delete workflow.syncAttempts; delete workflow.syncRetryAt;
        workflow.error = "";
        await this.saveWorkflow(state, workflow);
      }
      return this.publicWorkflow(workflow);
    }
    workflow.ownerDeletion ||= { id: eventId };
    const deletion = workflow.ownerDeletion;
    try {
      for (const side of ['source', 'target'] as const) {
        if (deletion.done?.includes(side)) continue;
        const task = await this.linkedTask(state, workflow, side);
        if (task) {
          if (workflow.fields.repeatFlag && (taskFields(task).startDate !== workflow.fields.startDate || taskFields(task).dueDate !== workflow.fields.dueDate)) throw new CollaborationError("关联重复任务已进入其他日期，请在滴答中删除对应任务，避免影响下一次任务");
          const { owner } = this.sideReference(workflow, side);
          await this.gateway.remove(owner, task.id, task.projectId);
          if (await this.gateway.get(owner, task.id, task.projectId)) throw new CollaborationError("删除尚未完成，正在自动重试");
        }
        deletion.done = [...(deletion.done || []), side];
        await this.saveWorkflow(state, workflow);
      }
      if (workflow.source.ownerId === null) delete state.buffer[workflow.source.taskId];
      event.type = "task-deleted"; event.comment = "";
      workflow.status = 'deleted'; workflow.taskAnomaly = false;
      delete workflow.ownerDeletion;
      delete workflow.completionRequest;
      delete workflow.edit; delete workflow.approval; delete workflow.recovery;
      delete workflow.reopenReceipt; delete workflow.sourceReopenReceipt; workflow.reopenPending = false; workflow.needsSubmission = false;
      workflow.error = ""; workflow.syncError = undefined;
    } catch (error) { workflow.error = error instanceof Error ? error.message : "删除尚未完成，正在自动重试"; }
    await this.saveWorkflow(state, workflow); return this.publicWorkflow(workflow);
  }
  workflowCommand(actor: string, command: WorkflowCommand) {
    return this.serial(async () => {
      await this.requireMember(actor);
      if (!command || !/^[a-f0-9-]{36}$/i.test(command.id) || !/^[a-f0-9-]{36}$/i.test(command.workflowId) || !Number.isSafeInteger(command.version)) throw new CollaborationError("流程参数无效", 400);
      const state = await this.read(), workflow = state.workflows[command.workflowId];
      if (!workflow) throw new CollaborationError("流程不存在", 404);
      if (isPersonalCollection(workflow)) throw new CollaborationError("自己的任务直接放入收集箱，不使用审批流程", 409);
      const signature = fingerprint({ actor, command }), prior = workflow.events.find(event => event.id === command.id);
      if (workflow.completionRequest?.id === command.id) {
        if (workflow.completionRequest.signature !== signature) throw new CollaborationError("操作编号已使用");
        if (workflow.ownerDeletion || workflow.status === 'deleted') return this.publicWorkflow(workflow);
        return this.completeByOwner(state, workflow, actor, command.id, signature);
      }
      if (prior) {
        if (prior.signature !== signature) throw new CollaborationError("操作编号已使用");
        if (workflow.status === 'deleted') return this.publicWorkflow(workflow);
        if (command.action === "delete-owner-task") {
          if (actor !== workflow.reviewerId) throw new CollaborationError("只有原任务所属成员或公共任务发布者能删除发起任务", 403);
          return this.deleteWorkflowTasks(state, workflow, command.id);
        }
        if (workflow.ownerDeletion) return workflow.ownerDeletion.id === command.id ? this.deleteWorkflowTasks(state, workflow, command.id) : this.publicWorkflow(workflow);
        if (command.action === "delete-claimed-task") return this.deleteWorkflowTasks(state, workflow, command.id);
        if (["nudge", "reply-nudge"].includes(command.action)) return this.publicWorkflow(workflow);
        if (command.action === "restore-workflow") return workflow.taskAnomaly && workflow.restoration?.id === command.id && workflow.restoration.generation === (workflow.missingGeneration || 0) ? this.restoreWorkflow(state, workflow) : this.publicWorkflow(workflow);
        if (workflow.edit?.id === command.id) return this.finishWorkflowEdit(state, workflow);
        if (workflow.edit) return this.publicWorkflow(workflow);
        return workflow.status === "approving" && actor === workflow.reviewerId ? this.finishApproval(state, workflow) : this.publicWorkflow(workflow);
      }
      if (workflow.status === 'deleted') throw new CollaborationError('此任务已删除并归档', 409);
      // These append-only communications recheck permissions and current state,
      // but do not discard a typed reply because an unrelated event arrived.
      if (command.action === "nudge" || command.action === "reply-nudge") {
        if (typeof command.comment !== "undefined" && typeof command.comment !== "string") throw new CollaborationError("回复内容无效", 400);
        const reply = command.action === "reply-nudge", comment = command.comment?.trim() || "";
        if (comment.length > 2000 || (reply && !comment)) throw new CollaborationError("请填写 1 至 2000 字的回复", 400);
        if (actor !== (reply ? workflow.claimantId : workflow.reviewerId)) throw new CollaborationError(reply ? "只有认领者可以回复催办" : "只有原任务所属成员或发布者可以催办", 403);
        if (!reply && ["creating", "done"].includes(workflow.status)) throw new CollaborationError("当前任务无需催办");
        if (reply) {
          if (!workflow.events.some(event => event.id === command.replyTo && event.type === "nudge")) throw new CollaborationError("催办记录不存在", 404);
          if (workflow.events.some(event => event.type === "reply-nudge" && event.replyTo === command.replyTo)) throw new CollaborationError("已经回复过此条催办");
        }
        workflow.events.push({ id: command.id, signature, actorId: actor, type: command.action, at: Date.now(), comment: reply ? comment : comment || "请查看任务进展，有空回复一下", files: [], ...(reply ? { replyTo: command.replyTo } : {}) });
        await this.saveWorkflow(state, workflow); return this.publicWorkflow(workflow);
      }
      if (workflow.version !== command.version) throw new CollaborationError("流程已更新，请刷新后操作");
      if (["delete-owner-task", "delete-claimed-task"].includes(command.action) || (command.action === "retry-workflow" && workflow.ownerDeletion)) {
        const permitted = command.action === 'delete-owner-task' ? actor === workflow.reviewerId : command.action === 'delete-claimed-task' ? actor === workflow.claimantId : [workflow.reviewerId, workflow.claimantId].includes(actor);
        if (!permitted) throw new CollaborationError("只有任务发起者或认领者能删除对应任务", 403);
        if (!workflow.ownerDeletion) {
          workflow.ownerDeletion = { id: command.id };
          workflow.events.push({ id: command.id, signature, actorId: actor, type: "task-delete-requested", at: Date.now(), comment: "", files: [] });
          if (workflow.source.ownerId === null) delete state.buffer[workflow.source.taskId];
          await this.saveWorkflow(state, workflow);
        }
        return this.deleteWorkflowTasks(state, workflow, workflow.ownerDeletion.id);
      }
      if (workflow.ownerDeletion) throw new CollaborationError("发起任务的删除结果尚未确认，请由发起者核对并继续");
      if (command.action === "restore-workflow") {
        if (![workflow.reviewerId, workflow.claimantId].includes(actor)) throw new CollaborationError("只有流程参与者能恢复任务", 403);
        if (!workflow.taskAnomaly || !["working", "submitted", "rejected", "approving"].includes(workflow.status)) throw new CollaborationError("此流程无需恢复任务");
        workflow.events.push({ id: command.id, signature, actorId: actor, type: "restore-requested", at: Date.now(), comment: "请求恢复缺失任务", files: [] });
        workflow.restoration = { id: command.id, generation: workflow.missingGeneration || 0 };
        await this.saveWorkflow(state, workflow); return this.restoreWorkflow(state, workflow);
      }
      if (workflow.recovery) throw new CollaborationError("任务恢复尚未完成，请先继续恢复");
      if (command.action === "update-workflow") {
        const fields = { ...(workflow.edit?.fields || workflow.fields), ...validateFields(command.fields) };
        if (fields.startDate && fields.dueDate && Date.parse(fields.startDate) > Date.parse(fields.dueDate)) throw new CollaborationError("截止时间不能早于开始时间", 400);
        if (workflow.edit) {
          const replaced = workflow.events.find(item => item.id === workflow.edit!.id);
          if (replaced) { replaced.type = "update-replaced"; replaced.comment = "此修改由后续详情设置替代"; }
        }
        const before = [workflow.fields.content, workflow.edit?.attachments?.before || '', workflow.edit?.fields.content || ''].join('\n');
        workflow.edit = { id: command.id, fields, attachments: { actor, before, publishBefore: workflow.fields.content, after: fields.content }, summary: workflowSettingChanges(workflow.fields, fields) };
        workflow.events.push({ id: command.id, signature, actorId: actor, type: "updating", at: Date.now(), comment: "已保存详情修改，正在同步关联任务", files: [] });
        await this.saveWorkflow(state, workflow);
        return this.finishWorkflowEdit(state, workflow);
      }
      if (command.action === "owner-complete") return this.completeByOwner(state, workflow, actor, command.id, signature);
      if (command.action === "retry-workflow") {
        if (workflow.completionRequest) return this.completeByOwner(state, workflow, actor, workflow.completionRequest.id, workflow.completionRequest.signature);
        if (workflow.edit) return this.finishWorkflowEdit(state, workflow);
        if (![workflow.claimantId, workflow.reviewerId].includes(actor)) throw new CollaborationError("只有流程参与者能重试", 403);
        if (workflow.reopenReceipt || workflow.sourceReopenReceipt) {
          const sides = await this.workflowSides(state, workflow);
          await this.syncExternalCompletion(state, workflow, sides.source, sides.target, true);
          return this.publicWorkflow(workflow);
        }
        if (workflow.status === "creating") return this.startWorkflow(state, workflow);
        if (workflow.status === "approving" && actor === workflow.reviewerId) return this.finishApproval(state, workflow);
        throw new CollaborationError("此流程无需重试");
      }
      if (workflow.edit) throw new CollaborationError("任务详情正在同步，请同步完成后提交或审批");
      if (workflow.taskAnomaly) throw new CollaborationError("该任务已被删除");
      if (!["submit", "approve", "reject"].includes(command.action)) throw new CollaborationError("流程操作无效", 400);
      const submit = command.action === "submit";
      if (actor !== (submit ? workflow.claimantId : workflow.reviewerId)) throw new CollaborationError(submit ? "只有认领者能提交完成" : "只有原任务所属用户或发布者能审批", 403);
      if (submit ? !["working", "rejected"].includes(workflow.status) : workflow.status !== "submitted") throw new CollaborationError("当前流程状态不支持此操作");
      if (submit && !isExecuting(this.publicWorkflow(workflow))) throw new CollaborationError('只有进行中任务可以提交审批');
      const comment = command.comment ?? "";
      if (typeof comment !== "string" || comment.length > 10000 || !Array.isArray(command.attachments || []) || (command.attachments?.length || 0) > 10) throw new CollaborationError("评语或附件参数无效", 400);
      const files: WorkflowFile[] = [];
      for (const id of [...new Set(command.attachments || [])]) {
        if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) throw new CollaborationError("附件无效", 400);
        const metadata = JSON.parse(await readFile(path.join(path.dirname(this.file), "workflow-files", `${id}.json`), "utf8").catch(() => { throw new CollaborationError("附件不存在，请重新上传", 400); }));
        if (metadata.workflowId !== workflow.id || metadata.actorId !== actor) throw new CollaborationError("附件不属于此流程或当前账号", 403);
        files.push({ id, name: metadata.name, size: metadata.size, url: `/api/room/tasks/files/${id}` });
      }
      if (command.action === "approve") return this.completeByOwner(state, workflow, actor, command.id, signature, { comment: comment.trim(), files });
      // A later explicit rejection supersedes an approval still waiting to read.
      if (workflow.completionRequest) { delete workflow.completionRequest; await this.saveWorkflow(state, workflow); }
      {
        const current = await this.workflowSides(state, workflow);
        const sides = await this.syncExternalCompletion(state, workflow, current.source, current.target, true);
        if (["approving", "done"].includes(workflow.status)) return this.publicWorkflow(workflow);
        if ([sides.source, sides.target].some(task => task?.status)) throw new CollaborationError("滴答任务已在流程外被勾选，请先恢复为未完成，再提交或审批");
        if (submit) {
          workflow.submitted = { source: sides.source ? remoteVersion(sides.source) : "", target: remoteVersion(sides.target) };
          workflow.submittedFields = { source: sides.source ? taskFields(sides.source) : workflow.fields, target: taskFields(sides.target) };
          workflow.needsSubmission = false;
        }
      }
      workflow.events.push({ id: command.id, signature, actorId: actor, type: command.action, at: Date.now(), comment: comment.trim(), files });
      state.executionPlans ||= {};
      const executionPlan = state.executionPlans[workflow.claimantId] ||= { version: 0, receipts: [] };
      executionPlan.version++;
      workflow.executing = true;
      workflow.status = submit ? "submitted" : "rejected";
      workflow.error = "";
      await this.saveWorkflow(state, workflow);
      return this.publicWorkflow(workflow);
    });
  }
  async attachmentAccess(actor: string, workflowId: string, upload = false, file?: { id: string; actorId: string }) {
    await this.requireMember(actor);
    if (!/^[a-f0-9-]{36}$/i.test(workflowId)) throw new CollaborationError("流程编号无效", 400);
    const workflow = (await this.read()).workflows[workflowId];
    if (!workflow) throw new CollaborationError("流程不存在", 404);
    if (file && file.actorId !== actor && !workflow.events.some(event => event.files.some(item => item.id === file.id))) throw new CollaborationError("附件尚未提交", 403);
    if (upload && (workflow.edit || !((actor === workflow.claimantId && isExecuting(this.publicWorkflow(workflow)) && ["working", "rejected"].includes(workflow.status)) || (actor === workflow.reviewerId && workflow.status === "submitted")))) throw new CollaborationError("当前账号不能为此流程添加附件", 403);
    return true;
  }
  personalCompletion<T>(actor: string, taskId: string, complete: () => Promise<T>) {
    return this.serial(async () => {
      const state = await this.read(), workflow = this.taskWorkflow(state, actor, taskId);
      if (workflow) {
        await this.requireMember(actor);
        const result = await this.completeByOwner(state, workflow, actor, randomUUID(), fingerprint({ actor, taskId, version: workflow.version }));
        if (result.error) throw new CollaborationError(result.error);
        return result;
      }
      // A lost HTTP response can leave an old checkbox visible after the workflow
      // finished. Read back that occurrence before falling through to ordinary completion.
      const completed = Object.values(state.workflows).filter(item => !isPersonalCollection(item) && item.status === "done" && (
        (item.source.ownerId === actor && item.source.taskId === taskId) ||
        (item.reviewerId === actor && item.reviewerTaskId === taskId) ||
        (item.claimantId === actor && item.targetId === taskId)
      )).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (completed) {
        const current = await this.gateway.get(actor, taskId);
        const side = completed.claimantId === actor && completed.targetId === taskId ? "target" : "source";
        if (!current || current.status === 2 || remoteVersion(current) === completed.submitted?.[side]) return this.publicWorkflow(completed);
      }
      return complete();
    });
  }
  async resetLegacy(actor: string) {
    await this.requireMember(actor);
    const current = await this.read();
    const needsMigration = !current.legacyReset || !!current.legacyCleanup?.length || Object.values(current.operations).some(op => op.action === "move") || Object.values(current.workflows).some(workflow => isPersonalCollection(workflow) && !["creating", "approving"].includes(workflow.status) && !workflow.edit && (workflow.status !== "done" || current.buffer[workflow.source.taskId]));
    if (!needsMigration) return { issues: [], removed: 0 };
    return this.serial(async () => {
      await this.requireMember(actor); const state = await this.read();
      const result = clearLegacyRecords(state);
      for (const workflow of Object.values(state.workflows).filter(isPersonalCollection)) {
        if (workflow.status === "creating" || workflow.status === "approving" || workflow.edit) continue;
        if (workflow.status !== "done" || state.buffer[workflow.source.taskId]) {
          // Existing self-claims become ordinary inbox tasks without changing Dida status.
          delete state.buffer[workflow.source.taskId]; workflow.status = "done"; workflow.error = "";
          workflow.version++; workflow.updatedAt = Date.now(); state.revision++; result.changed = true;
        }
      }
      if (result.changed) await this.write(state);
      return { issues: [], removed: result.removed };
    });
  }
  private requireCompletionOwner(state: State, actor: string, source?: TaskSource) {
    const owner = source?.ownerId || (source ? state.buffer[source.taskId]?.publisherId : undefined);
    if (!owner || actor !== owner) throw new CollaborationError("只有原任务所属成员或公共任务发布者能勾选完成；其他成员可以编辑信息", 403);
  }
  execute(actorId: string, command: CollaborationCommand) {
    return this.serial(async () => {
      if (!command || typeof command.id !== "string" || !/^[a-f0-9-]{36}$/i.test(command.id) || !["create", "update", "move", "complete", "delete"].includes(command.action)) throw new CollaborationError("协作操作无效", 400);
      if (command.action === "move") throw new CollaborationError("任务分配已改为认领审批，请刷新页面", 409);
      const members = await this.gateway.members();
      if (!members.some(member => member.id === actorId)) throw new CollaborationError("成员不存在", 403);
      const state = await this.read(), signature = fingerprint({ actorId, command });
      let op = state.operations[command.id];
      if (op) {
        if (op.signature !== signature) throw new CollaborationError("操作编号已被使用");
        if (op.action === "complete" && op.status === "pending") this.requireCompletionOwner(state, actorId, op.source);
        if (op.status !== "pending") return this.publicOperation(op);
      } else {
        let fields = taskFields({}), beforeContent = ''; const source = command.source;
        if (command.action === "create") { fields = taskFields(validateFields(command.fields)); if (!fields.title) throw new CollaborationError("请填写任务标题", 400); }
        else {
          if (!source || (source.ownerId !== null && !members.some(member => member.id === source!.ownerId)) || typeof source.taskId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(source.taskId) || typeof source.version !== "string") throw new CollaborationError("任务来源无效", 400);
          if (command.action === "complete") this.requireCompletionOwner(state, actorId, source);
          if (this.taskWorkflow(state, source.ownerId, source.taskId)) throw new CollaborationError("此任务正在协作，请通过工作流程提交或审批");
          if (Object.values(state.operations).some(item => item.status === "pending" && ((item.source?.ownerId === source!.ownerId && item.source.taskId === source!.taskId) || (item.to === source!.ownerId && item.targetId === source!.taskId)))) throw new CollaborationError("任务正在处理中，请先完成或取消之前的操作");
          const current = await this.source(state, source);
          if (!current || current.remote?.status) throw new CollaborationError("任务已完成或已移走，请刷新");
          if (current.version !== source.version) throw new CollaborationError("任务已被修改，请刷新后重新操作");
          fields = current.fields;
          beforeContent = fields.content;
          if (command.action === "update") fields = await this.fieldsAfterTask(state, { ...fields, ...validateFields(command.fields) }, command.dateAfter, source.ownerId, source);

        }
        if (fields.startDate && fields.dueDate && Date.parse(fields.startDate) > Date.parse(fields.dueDate)) throw new CollaborationError("截止时间不能早于开始时间", 400);
        op = { id: command.id, signature, actorId, action: command.action, title: fields.title, from: source?.ownerId ?? null, to: null, source, fields, targetId: randomUUID(), creation: { state: "new" }, status: "pending", phase: "prepared", error: "", createdAt: Date.now(), updatedAt: Date.now() };
        if (['create', 'update'].includes(command.action)) op.attachments = { actor: actorId, before: beforeContent, after: fields.content };
        state.operations[op.id] = op; await this.checkpoint(state, op);
      }
      return this.run(state, op);
    });
  }
  resume(actorId: string, id: string, cancel = false) {
    return this.serial(async () => {
      if (!/^[a-f0-9-]{36}$/i.test(id)) throw new CollaborationError("操作编号无效", 400);
      if (!(await this.gateway.members()).some(member => member.id === actorId)) throw new CollaborationError("成员不存在", 403);
      const state = await this.read(), op = state.operations[id];
      const collection = state.workflows[id];
      if (!op && collection && isPersonalCollection(collection)) {
        if (actorId !== collection.claimantId) throw new CollaborationError("只有任务发布者能继续放入自己的收集箱", 403);
        if (collection.status === "done" && !collection.edit) return collectionOperation(collection);
        if (cancel) throw new CollaborationError("创建请求已提交，需先确认收集箱中的任务，请点击继续", 409);
        return collectionOperation(await this.finishCollection(state, collection));
      }
      if (!op) throw new CollaborationError("操作不存在", 404);
      if (op.action === "move") throw new CollaborationError("旧转移已停用，请使用旧记录清理");
      if (op.status !== "pending") return this.publicOperation(op);
      if (!cancel) {
        if (op.action === "complete") this.requireCompletionOwner(state, actorId, op.source);
        return this.run(state, op);
      }
      const current = op.source ? await this.source(state, op.source) : null;
      if (op.action === "update" && current && sameFields(current.fields, op.fields)) { await this.finish(state, op); return this.publicOperation(op); }
      else if ((op.action === "delete" && !current) || (op.action === "complete" && current?.remote?.status === 2)) { await this.finish(state, op); return this.publicOperation(op); }
      op.status = "cancelled"; op.error = ""; await this.checkpoint(state, op); return this.publicOperation(op);
    });
  }
  async recover(): Promise<never> {
    throw new CollaborationError("旧转移已停用，请重新认领", 409);
  }
  private async run(state: State, op: Operation) {
    if (op.action === "complete") this.requireCompletionOwner(state, op.actorId, op.source);
    try {
      if (op.source && this.taskWorkflow(state, op.source.ownerId, op.source.taskId)) throw new CollaborationError("此任务正在协作，请通过工作流程提交或审批");
      if (op.attachments) await this.gateway.taskAttachments?.publish(op.attachments.actor, op.attachments.before, op.attachments.after);
      if (op.action === "create") state.buffer[op.targetId] = { fields: op.fields, version: 1, publisherId: op.actorId, publishedAt: op.createdAt };
      else if (op.action === "move") throw new CollaborationError("旧转移已停用，请重新认领");
      else {
        const source = await this.source(state, op.source!);
        if (op.action === "delete" && !source) { await this.finish(state, op); return this.publicOperation(op); }
        if (!source) throw new CollaborationError("任务已移走，请取消此次操作并刷新");
        if ((op.action === "update" && sameFields(source.fields, op.fields)) || (op.action === "complete" && source.remote?.status === 2)) { await this.finish(state, op); return this.publicOperation(op); }
        if (source.version !== op.source!.version) throw new CollaborationError("任务已被修改，请取消此次操作并刷新");
        if (op.source!.ownerId) {
          if (op.action === "update") await this.gateway.update(op.source!.ownerId, op.source!.taskId, op.fields, source.version);
          else if (op.action === "complete") await this.gateway.complete(op.source!.ownerId, op.source!.taskId);
          else await this.gateway.remove(op.source!.ownerId, op.source!.taskId);
        } else if (op.action === "update") state.buffer[op.source!.taskId] = { ...state.buffer[op.source!.taskId], fields: op.fields, version: Number(source.version) + 1 };
        else delete state.buffer[op.source!.taskId];
      }
      await this.finish(state, op);
    } catch (error) { op.error = error instanceof Error ? error.message : "操作结果未确认，请继续处理"; await this.checkpoint(state, op); }
    return this.publicOperation(op);
  }
}
