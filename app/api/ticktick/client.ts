const kind = (value: unknown): string => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const idKind = (value: unknown) => typeof value !== "string" ? kind(value) : value === "inbox" ? "inbox-alias" : /^[A-Za-z0-9_-]{1,100}$/.test(value) ? "concrete-id" : "other-string";

// Report only known field types/counts, never identifiers, task text or credentials.
export function inboxResponseShape(value: unknown) {
  const root = record(value), project = record(root.project);
  const tasks = Array.isArray(root.tasks) ? root.tasks : [];
  const ids = tasks.map(task => record(task).projectId);
  return {
    rootType: kind(value),
    fields: Object.fromEntries(["project", "tasks", "columns", "data", "id", "projectId", "errorCode", "error", "message"].map(key => [key, kind(root[key])])),
    project: { id: idKind(project.id), topLevelId: idKind(root.id), topLevelProjectId: idKind(root.projectId) },
    tasks: { count: tasks.length, concreteProjectIds: new Set(ids.filter(id => idKind(id) === "concrete-id")).size, aliasCount: ids.filter(id => id === "inbox").length, missingProjectIdCount: ids.filter(id => id == null).length },
  };
}

export type TickProject = { id: string; name: string; closed?: boolean };
export type TickTask = { id: string; projectId: string; title: string; status?: number; dueDate?: string; startDate?: string; isAllDay?: boolean };

const sharedReads = globalThis as typeof globalThis & { didaReads?: Map<string, Promise<Response>> };
const reads = sharedReads.didaReads ||= new Map<string, Promise<Response>>();
export async function tickFetch(path: string, token: string, init?: RequestInit) {
  const read = !init?.method || init.method === 'GET' || ['/task/filter', '/task/completed'].includes(path);
  const prefix = JSON.stringify(token) + ':';
  const invalidate = () => { for (const key of reads.keys()) if (key.startsWith(prefix)) reads.delete(key); };
  if (!read) invalidate();
  const key = prefix + JSON.stringify([path, init?.body, init?.headers]);
  const perform = () => fetch(`https://api.dida365.com/open/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers || {}) },
    signal: init?.signal || AbortSignal.timeout(15_000), cache: "no-store",
  });
  if (!read || init?.signal) { try { return await perform(); } finally { if (!read) invalidate(); } }
  let pending = reads.get(key);
  if (!pending) {
    pending = perform(); reads.set(key, pending);
    void pending.finally(() => { if (reads.get(key) === pending) reads.delete(key); }).catch(() => undefined);
  }
  return (await pending).clone();
}

export class TickApiError extends Error {
  status: number;
  diagnostic?: string;
  constructor(message: string, status = 502, diagnostic?: string) { super(message); this.status = status; this.diagnostic = diagnostic; }
}

const knownInboxes = new Map<string, string>();
const concreteProjectId = (value: unknown): value is string => typeof value === "string" && value !== "inbox" && /^[A-Za-z0-9_-]{1,100}$/.test(value);

// Inbox responses may omit project entirely. Only infer an ID when every task
// returned by this account-scoped endpoint agrees; never pick the first of several.
// An empty, previously unseen inbox can be displayed using the read alias, but
// callers must resolve a concrete ID before attempting any task write.
export async function tickInboxData<T extends { id: string; projectId: string } = TickTask>(token: string): Promise<{ projectId: string; tasks: T[] }> {
  let response: Response;
  try {
    response = await tickFetch("/project/inbox/data", token);
  } catch { throw new TickApiError("滴答收集箱暂时无法连接，请稍后刷新"); }
  if (!response.ok) throw new TickApiError(response.status === 401 ? "滴答授权已失效，请重新连接" : response.status === 403 ? "滴答授权缺少收集箱读取权限" : response.status === 429 ? "滴答请求较频繁，请稍后刷新" : "滴答收集箱暂时无法读取，请稍后刷新", response.status);
  const data = await response.json().catch(() => null);
  const invalid = () => new TickApiError("滴答收集箱格式暂不兼容，请查看连接诊断", 502, JSON.stringify({ version: 2, endpoint: "/project/inbox/data", status: response.status, shape: inboxResponseShape(data) }, null, 2));
  if (!Array.isArray(data?.tasks)) throw invalid();
  let projectId: string | undefined = concreteProjectId(data?.project?.id) ? data.project.id : undefined;
  if (!projectId && data.tasks.length) {
    const ids = data.tasks.map((task: unknown) => record(task).projectId);
    if (!ids.every(concreteProjectId) || new Set(ids).size !== 1 || data.tasks.some((task: unknown) => typeof record(task).id !== "string")) throw invalid();
    projectId = ids[0];
  }
  if (!projectId && !data.tasks.length) {
    projectId = knownInboxes.get(token);
    if (!projectId) return { projectId: "inbox", tasks: [] };
  }
  if (!projectId) throw invalid();
  knownInboxes.delete(token); knownInboxes.set(token, projectId);
  if (knownInboxes.size > 100) knownInboxes.delete(knownInboxes.keys().next().value!);
  return { projectId, tasks: data.tasks.filter((task: T | null) => task && typeof task.id === "string" && task.projectId === projectId) };
}

// Displaying an empty list needs no concrete ID. Only callers that must locate
// or write a task resolve optional metadata, reusing the already fetched list.
export async function resolveTickInbox<T extends { id: string; projectId: string } = TickTask>(token: string, inbox?: { projectId: string; tasks: T[] }) {
  const data = inbox || await tickInboxData<T>(token);
  if (data.projectId !== 'inbox') return data;
  const known = knownInboxes.get(token);
  if (known) return { ...data, projectId: known };
  const response = await tickFetch('/project/inbox', token);
  const project = response.ok ? await response.json().catch(() => null) : null;
  if (concreteProjectId(project?.id)) {
    knownInboxes.set(token, project.id);
    if (knownInboxes.size > 100) knownInboxes.delete(knownInboxes.keys().next().value!);
    return { ...data, projectId: project.id as string };
  }
  return data;
}

export type TaskView = "today" | "week" | "undated";
export function filterTasksByView(tasks: TickTask[], view: TaskView, now = Date.now()) {
  const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  const finalKey = dateKey.format(now + (view === "week" ? 7 * 86400000 : 0));
  return tasks.filter(task => {
    if (task.status) return false;
    const date = task.dueDate || task.startDate;
    if (view === "undated") return !date;
    return !!date && /^\d{4}-\d{2}-\d{2}/.test(date) && date.slice(0, 10) <= finalKey;
  }).sort((a, b) => view === "undated" ? a.title.localeCompare(b.title, "zh-CN") : Date.parse(a.dueDate || a.startDate || "") - Date.parse(b.dueDate || b.startDate || ""));
}
