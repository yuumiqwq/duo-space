import { createHash } from 'node:crypto';
import type { ClaimWorkflow, OperationView, TaskFields } from '../../../collaboration-types';
import { allDaySelection } from '../../../task-date-input.ts';
import { comparableSettings, mergeTaskSettings, type SettingsIntent } from '../../../task-settings-merge.ts';

export type RemoteTask = Partial<TaskFields> & { id: string; projectId: string; status?: number; parentId?: string; [key: string]: unknown };
export type SettingsBaseline = { fields: TaskFields; status: number; parentId: string };

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
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export const remoteVersion = (task: RemoteTask) => fingerprint({ fields: taskFields(task), status: task.status || 0, parentId: task.parentId || "", desc: task.desc || "", etag: task.etag || "" });
export function comparableFields(task: Partial<TaskFields>) {
  return comparableSettings(taskFields(task));
}
export const sameFields = (a: Partial<TaskFields>, b: Partial<TaskFields>) => fingerprint(comparableFields(a)) === fingerprint(comparableFields(b));
export const taskSettingsVersion = (task: RemoteTask) => fingerprint({ fields: comparableFields(task), status: task.status || 0, parentId: task.parentId || '' });
const fieldLabels: Record<keyof TaskFields, string> = { title: "标题", content: "说明", priority: "优先级", startDate: "开始时间", dueDate: "截止时间", isAllDay: "全天设置", timeZone: "时区", tags: "标签", reminders: "提醒", repeatFlag: "重复规则", repeatFrom: "重复计算方式", desc: "检查项说明", kind: "任务类型", items: "检查项" };
export function canResumeSettings(task: RemoteTask, fields: TaskFields, before?: SettingsBaseline): boolean {
  if (!before || (task.status || 0) !== before.status || (task.parentId || '') !== before.parentId) return false;
  const current = comparableFields(task), desired = comparableFields(fields), original = comparableFields(before.fields);
  return (Object.keys(fieldLabels) as (keyof TaskFields)[]).every(key => fingerprint(current[key]) === fingerprint(original[key]) || fingerprint(current[key]) === fingerprint(desired[key]));
}
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
export function editedTaskFields(previous: TaskFields, patch: Partial<TaskFields>) {
  const fields = { ...previous, ...patch };
  return ['startDate', 'dueDate', 'isAllDay'].some(key => Object.hasOwn(patch, key)) ? allDaySelection(fields) : fields;
}
export function editBase(input: TaskFields | undefined): TaskFields | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CollaborationError('任务内容无效', 400);
  const { desc, kind, items, repeatFrom, ...rest } = input;
  if (typeof desc !== 'string' || typeof kind !== 'string' || typeof repeatFrom !== 'string' || !Array.isArray(items) || items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new CollaborationError('任务内容无效', 400);
  const editable = Object.fromEntries(Object.keys(fieldLabels).filter(key => !['desc', 'kind', 'items', 'repeatFrom'].includes(key)).map(key => [key, rest[key as keyof typeof rest]]));
  return taskFields({ ...validateFields(editable), desc, kind, items, repeatFrom });
}
export function mergedSettings(intent: SettingsIntent, current: TaskFields, message = '关联任务在同步期间被修改，已暂停覆盖，请核对后重试') {
  const merged = mergeTaskSettings(intent.base, intent.desired, current);
  if (merged.conflicts.length) throw new CollaborationError(message);
  return merged.fields;
}
