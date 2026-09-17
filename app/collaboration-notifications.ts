import type { ClaimWorkflow, WorkflowEvent, WorkflowSyncIssue } from "./collaboration-types";

export type TaskNotice = { id: string; kind: "public" | "workflow" | "sync-error"; title: string; body: string; at: number; actorId: string; recipients?: string[]; taskId?: string; workflowId?: string; operationId?: string; eventId?: string; eventType?: string; rejection?: Pick<WorkflowEvent, 'comment' | 'files'> & { claimantId: string; dismissed: boolean } };
export type TaskNoticeState = { version?: number; known: string[]; entries: TaskNotice[]; read: Record<string, string[]>; dismissedRejections?: Record<string, string[]>; attempted: string[] };
export const isWorkflowSettingsNotice = (notice: TaskNotice) => notice.kind === 'workflow' && ['updated', 'updating', 'update-replaced', 'reject'].includes(notice.eventType || '');
type NoticeSource = { buffer: Record<string, { fields: { title: string }; publisherId?: string; stagedBy?: string; completedAt?: number }>; workflows: Record<string, ClaimWorkflow>; operations?: Record<string, { title: string; syncIssue?: WorkflowSyncIssue }>; notifications?: TaskNoticeState };
export const silentWorkflowEvent = (type?: string) => ["external-claimant-check", "external-task-reopened", "task-relocated", "task-anomaly"].includes(type || "");
export function workflowEventPresentation(event: WorkflowEvent, pendingSummary?: string): WorkflowEvent {
  if (!["updating", "updated", "update-replaced"].includes(event.type)) return event;
  const transportMessage = ["已保存详情修改，正在同步关联任务", "此修改由后续详情设置替代", "任务详情已同步到关联任务；待审批任务需按最新内容重新提交", "旧记录未保存具体修改内容"].includes(event.comment);
  return { ...event, type: "updated", comment: transportMessage || !event.comment ? pendingSummary || "" : event.comment };
}
export const workflowEventLabels: Record<string, string> = { "external-owner-complete": "原任务方已在滴答完成", "external-claimant-check": "认领任务提前勾选", "external-task-reopened": "已恢复未完成", claimed: "认领", "task-delete-requested": "删除任务", "task-deleted": "已删除任务", "owner-delete-requested": "删除发起任务", "owner-task-deleted": "已删除发起任务", "claimant-delete-requested": "删除认领任务", "claimant-task-deleted": "已删除认领任务", submit: "提交完成", approve: "审批通过", reject: "打回修改", completed: "完成同步", "owner-complete": "发布者直接完成", updating: "修改详情", updated: "修改了详细设置", "update-replaced": "详情修改已替代", "task-anomaly": "任务状态异常", "task-relocated": "关联位置已更新", "restore-requested": "恢复任务", "tasks-restored": "任务已恢复", nudge: "催办", "reply-nudge": "回复催办" };
function available(source: NoticeSource): TaskNotice[] {
  const items: TaskNotice[] = Object.entries(source.buffer).filter(([, task]) => !task.stagedBy && !task.completedAt).map(([id, task]) => ({ id: `public:${id}`, taskId: id, kind: "public", title: task.fields.title, body: "任务板有一项新公共任务", at: 0, actorId: task.publisherId || "" }));
  for (const workflow of Object.values(source.workflows)) {
    if (workflow.source.ownerId === null && workflow.reviewerId === workflow.claimantId) continue;
    for (const event of workflow.events.map(event => workflowEventPresentation(event)).filter(event => event.type !== "completed" && !silentWorkflowEvent(event.type))) items.push({ id: `workflow:${workflow.id}:${event.id}`, workflowId: workflow.id, eventId: event.id, eventType: event.type, kind: "workflow", title: workflow.title, body: `${workflowEventLabels[event.type] || "流程更新"}${event.comment ? `：${event.comment.slice(0, 160)}` : ""}`, at: event.at, actorId: event.actorId, recipients: [...new Set([workflow.reviewerId, workflow.claimantId])] });
    const issue = workflow.syncIssue;
    if (issue) items.push({ id: `sync-error:${workflow.id}:${issue.id}`, workflowId: workflow.id, kind: "sync-error", title: workflow.title, body: issue.message, at: issue.at, actorId: "", recipients: [issue.recipientId] });
  }
  for (const [id, operation] of Object.entries(source.operations || {})) {
    const issue = operation.syncIssue;
    if (issue) items.push({ id: `sync-error:operation:${id}:${issue.id}`, operationId: id, kind: 'sync-error', title: operation.title, body: issue.message, at: issue.at, actorId: '', recipients: [issue.recipientId] });
  }
  return items;
}
export function initializeTaskNotices(source: NoticeSource) {
  // Existing history is a migration baseline, never a burst of new alerts.
  source.notifications ||= { known: available(source).map(item => item.id), entries: [], read: {}, attempted: [] };
  return source.notifications;
}
export function collectTaskNotices(source: NoticeSource) {
  const notices = initializeTaskNotices(source), known = new Set(notices.known), entries = new Map(notices.entries.map(item => [item.id, item]));
  for (const item of available(source)) if (!known.has(item.id)) {
    known.add(item.id); notices.known.push(item.id); notices.entries.push({ ...item, at: item.at || Date.now() });
    notices.version = (notices.version || 0) + 1;
  } else {
    const stored = entries.get(item.id);
    if (stored && (stored.body !== item.body || stored.eventType !== item.eventType)) { Object.assign(stored, item); notices.version = (notices.version || 0) + 1; }
  }
}
export const activeTaskNotice = (source: NoticeSource, notice: TaskNotice) => notice.kind !== "sync-error" || (notice.operationId
  ? notice.id === `sync-error:operation:${notice.operationId}:${source.operations?.[notice.operationId]?.syncIssue?.id}`
  : notice.id === `sync-error:${notice.workflowId}:${source.workflows[notice.workflowId!]?.syncIssue?.id}`);
export const receivesTaskNotice = (notice: TaskNotice, actor: string) => !silentWorkflowEvent(notice.eventType) && notice.actorId !== actor && (!notice.recipients || notice.recipients.includes(actor));
// Use one modal slot for nudges and rejections, retaining the current notice
// until it is acknowledged, including an acknowledgement from another device.
export function nextTaskPrompt(notices: TaskNotice[], actor: string, current: TaskNotice | null = null): TaskNotice | null {
  const prompts = notices.filter(notice => notice.kind === 'workflow' && receivesTaskNotice(notice, actor) &&
    (notice.eventType === 'nudge' || (notice.eventType === 'reject' && notice.rejection?.claimantId === actor && !notice.rejection.dismissed)));
  return prompts.find(notice => notice.id === current?.id) || prompts[0] || null;
}
export function unreadTaskNotices(source: NoticeSource, actor: string): TaskNotice[] {
  const notices = initializeTaskNotices(source), seen = new Set(notices.read[actor] || []);
  const current = new Map(available(source).map(item => [item.id, item]));
  return notices.entries.filter(item => item.eventType !== "completed" && activeTaskNotice(source, item) && receivesTaskNotice(item, actor) && !seen.has(item.id) && (item.kind !== "public" || (source.buffer[item.taskId!] && !source.buffer[item.taskId!].completedAt))).map(item => {
    const notice = current.get(item.id) || item;
    const workflow = notice.workflowId && source.workflows[notice.workflowId];
    const event = notice.kind === 'workflow' && notice.eventType === 'reject' && workflow && workflow.claimantId === actor && workflow.events.find(event => event.id === notice.eventId && event.type === 'reject');
    // The full comment and attachments come from the immutable event, not the
    // truncated push summary, and are not copied into persisted notice records.
    return event ? { ...notice, rejection: { claimantId: actor, comment: event.comment, files: event.files, dismissed: !!notices.dismissedRejections?.[actor]?.includes(notice.id) } } : notice;
  });
}
