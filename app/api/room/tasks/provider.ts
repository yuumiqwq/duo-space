import { getUser, listRoomMembers } from "../../identity/store";
import { decryptToken } from "../../ticktick/crypto";
import { tickFetch, tickInboxData, TickApiError } from "../../ticktick/client";
import { CollaborationError, remoteVersion, sameFields, verificationIssue, type Gateway, type RemoteTask } from "./store";
import type { TaskFields } from "../../../collaboration-types";

type Context = { token: string; projectId: string; tasks: RemoteTask[]; encrypted: string; expires: number; search?: Promise<RemoteTask[]>; projects?: Promise<string[]>; completed?: Map<string, Promise<RemoteTask[]>> };
const contexts = new Map<string, Context>();
const contextLoads = new Map<string, { id: symbol; encrypted: string; promise: Promise<Context> }>();
async function context(owner: string, refreshInbox = false): Promise<Context> {
  const before = contexts.get(owner);
  const user = await getUser(owner);
  if (!user?.ticktickToken) throw new CollaborationError("该成员尚未连接滴答清单", 422);
  const cached = contexts.get(owner);
  if ((!refreshInbox || cached !== before) && cached?.encrypted === user.ticktickToken && cached.expires > Date.now()) return cached;
  const pending = contextLoads.get(owner);
  if (pending?.encrypted === user.ticktickToken) return pending.promise;
  let token: string;
  try { token = decryptToken(user.ticktickToken); } catch { throw new CollaborationError("该成员需要重新连接滴答清单", 422); }
  const encrypted = user.ticktickToken;
  const loadId = Symbol(owner);
  const promise: Promise<Context> = (async () => {
    let inbox;
    try { inbox = await tickInboxData<RemoteTask>(token); }
    catch (error) { throw new CollaborationError(error instanceof TickApiError ? error.message : "收集箱暂时无法读取，请稍后刷新", error instanceof TickApiError && [401, 403].includes(error.status) ? 422 : 502, error instanceof TickApiError ? error.diagnostic : undefined); }
    const next = { token, ...inbox, encrypted, expires: Date.now() + 15000 };
    if (contextLoads.get(owner)?.id === loadId) contexts.set(owner, next);
    return next;
  })();
  contextLoads.set(owner, { id: loadId, encrypted, promise });
  try { return await promise; }
  finally { if (contextLoads.get(owner)?.promise === promise) contextLoads.delete(owner); }
}
async function request(owner: string, route: string, init?: RequestInit, missing = false) {
  const account = await context(owner);
  // Existing workflow links keep their concrete project ID across restarts.
  // An unknown empty inbox blocks only requests that still need that ID,
  // not exact linked-task reads/deletes or account-wide absence checks.
  if (account.projectId === "inbox" && (route.includes("{inbox}") || route.startsWith("/project/inbox/"))) throw new CollaborationError("收集箱为空且滴答未返回具体编号，暂不能分配任务；请先在滴答收集箱添加一项后刷新", 422);
  const response = await tickFetch(route.replaceAll("{inbox}", encodeURIComponent(account.projectId)), account.token, init);
  if (missing && response.status === 404) return null;
  if (!response.ok) throw new CollaborationError(response.status === 429 ? "滴答请求较频繁，请稍后重试" : response.status === 401 || response.status === 403 ? "滴答授权不足或已失效，请该成员重新连接" : "滴答操作暂未完成，请稍后继续处理", response.status >= 500 ? 502 : 422);
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text && init?.method && init.method !== "GET") return {};
  try { return JSON.parse(text); } catch { throw new CollaborationError("滴答返回的数据不完整，请稍后重试", 502); }
}
const validId = (id: string) => /^[A-Za-z0-9_-]{1,100}$/.test(id);
const payload = (fields: TaskFields) => ({ ...fields, startDate: fields.startDate?.replace(/\.\d{3}Z$/, "+0000") ?? null, dueDate: fields.dueDate?.replace(/\.\d{3}Z$/, "+0000") ?? null });
async function completedTask(owner: string, account: Context, id: string, completedAfter?: number) {
  if (completedAfter !== undefined && (!Number.isFinite(completedAfter) || completedAfter < 0)) throw new CollaborationError("任务发布日期无效", 400);
  const queries = account.completed ||= new Map<string, Promise<RemoteTask[]>>();
  const key = completedAfter === undefined ? "all" : String(completedAfter);
  if (!queries.has(key)) queries.set(key, request(owner, "/task/completed", { method: "POST", body: JSON.stringify(completedAfter === undefined ? {} : { startDate: new Date(completedAfter).toISOString() }) }).then(data => {
    if (!Array.isArray(data) || data.length > 200 || data.some(task => !task || typeof task.id !== "string" || !validId(task.id) || typeof task.projectId !== "string" || !validId(task.projectId) || task.status !== 2 || typeof task.title !== "string" || !task.title || (completedAfter !== undefined && (typeof task.completedTime !== "string" || !Number.isFinite(Date.parse(task.completedTime)) || Date.parse(task.completedTime) < completedAfter)))) throw new CollaborationError("滴答完成记录不完整，请稍后重试", 502);
    return data as RemoteTask[];
  }));
  const tasks = await queries.get(key)!;
  const found = tasks.find(task => task.id === id);
  if (found) return found;
  // Stop at the provider's 200-record cap for this inclusive publication query.
  // A full unmatched page cannot establish that the task was deleted.
  if (tasks.length === 200) throw new CollaborationError("滴答完成记录不完整，请稍后重试", 502);
  return null;
}
export const gateway: Gateway = {
  async members() { return Promise.all((await listRoomMembers()).map(async member => ({ ...member, connected: !!(await getUser(member.id))?.ticktickToken }))); },
  async inbox(owner) {
    const account = await context(owner, true);
    return { projectId: account.projectId, tasks: account.tasks };
  },
  async get(owner, id, projectId) {
    if (!validId(id) || (projectId !== undefined && !validId(projectId))) throw new CollaborationError("任务编号无效", 400);
    const account = await context(owner);
    const project = projectId || account.projectId;
    const task = await request(owner, `/project/${encodeURIComponent(project)}/task/${encodeURIComponent(id)}`, undefined, true);
    if (task && (task.id !== id || task.projectId !== project)) throw new CollaborationError("滴答返回的任务编号或清单与请求不符", 403);
    return task as RemoteTask | null;
  },
  async locate(owner, id, projectId, completedAfter) {
    const found = await gateway.get(owner, id, projectId);
    if (found && !found.status) return found;
    let completed = found?.status === 2 ? found : null;
    const account = await context(owner);
    account.search ||= request(owner, "/task/filter", { method: "POST", body: JSON.stringify({ status: [0] }) }).then(data => {
      if (!Array.isArray(data) || data.some(task => !task || typeof task.id !== "string" || !validId(task.id) || typeof task.projectId !== "string" || !validId(task.projectId) || task.status)) throw new CollaborationError("滴答状态查询返回的数据不完整，请稍后重试", 502);
      return data as RemoteTask[];
    });
    const unfinished = await account.search;
    const candidate = unfinished.find(task => task.id === id);
    if (candidate) {
      const detail = await gateway.get(owner, id, candidate.projectId);
      if (detail && !detail.status) return detail;
      if (detail?.status === 2) completed = detail;
    }
    // An uncapped account-wide result exhausts unfinished tasks. Only a full
    // page needs per-project fallback before querying completed history.
    if (unfinished.length < 200) return completed || await completedTask(owner, account, id, completedAfter);
    account.projects ||= request(owner, "/project").then(data => {
      if (!Array.isArray(data) || data.some(project => !project || typeof project.id !== "string" || !validId(project.id))) throw new CollaborationError("滴答清单列表不完整，请稍后重试", 502);
      return [...new Set([account.projectId, ...data.map(project => project.id as string)])];
    });
    const projects = (await account.projects).filter(project => project !== (projectId || account.projectId) && project !== "inbox");
    for (let index = 0; index < projects.length; index += 3) {
      const tasks = await Promise.all(projects.slice(index, index + 3).map(project => gateway.get(owner, id, project)));
      const open = tasks.find(task => task && !task.status); if (open) return open;
      completed ||= tasks.find(task => task?.status === 2) || null;
    }
    return completed || await completedTask(owner, account, id, completedAfter);
  },
  async create(owner, id, fields, receipt) {
    const existing = await gateway.get(owner, id);
    if (existing) { if (existing.status || !sameFields(existing, fields)) throw new CollaborationError(verificationIssue(existing, fields)); return; }
    const account = await context(owner);
    const data = await request(owner, "/task/batch", { method: "POST", body: JSON.stringify({ add: [{ ...payload(fields), id, projectId: account.projectId }] }) });
    if (data?.id2error?.[id] && data.id2error[id] !== "EXISTED") throw new CollaborationError("接收方未接受任务，请检查授权或账户配额", 422);
    // A batch add may allocate its own ID. The response, not the proposed ID,
    // identifies the task that was actually created.
    const ids = data?.id2etag && typeof data.id2etag === "object" ? Object.keys(data.id2etag) : [];
    const actualId = ids.length === 1 ? ids[0] : ids.includes(id) ? id : undefined;
    if (!actualId || !/^[A-Za-z0-9_-]{1,100}$/.test(actualId)) throw new CollaborationError("滴答未返回明确的创建编号，已停止重复创建，请核对已有副本");
    await receipt?.(actualId);
    const created = await gateway.get(owner, actualId);
    if (!created || created.status || !sameFields(created, fields)) throw new CollaborationError(verificationIssue(created, fields));
  },
  async update(owner, id, fields, version, projectId) {
    const account = await context(owner), existing = await gateway.get(owner, id, projectId);
    if (!existing) throw new CollaborationError("任务不存在");
    if (remoteVersion(existing) !== version) throw new CollaborationError("任务刚被修改，请刷新后重新编辑");
    // Keep provider-specific task fields while updating only the editor's supported values.
    await request(owner, `/task/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ ...existing, ...payload(fields), id, projectId: projectId || account.projectId }) });
    const saved = await gateway.get(owner, id, projectId);
    if (!saved || !sameFields(saved, fields)) throw new CollaborationError("关联任务的修改正在自动同步");
  },
  async remove(owner, id, projectId) {
    if (!validId(id) || (projectId !== undefined && !validId(projectId))) throw new CollaborationError("任务编号无效", 400);
    const response = await request(owner, `/project/${projectId ? encodeURIComponent(projectId) : "{inbox}"}/task/${encodeURIComponent(id)}`, { method: "DELETE" }, true);
    if (response === null) return "missing";
  },
  async reopen(owner, before, completedAfter) {
    const existing = await gateway.get(owner, before.id, before.projectId) || await gateway.locate!(owner, before.id, before.projectId, completedAfter);
    if (!existing) throw new CollaborationError("关联任务缺失，请刷新后恢复任务");
    if (!existing.status && sameFields(existing, before)) return existing;
    if (existing.status !== 2 || remoteVersion(existing) !== remoteVersion(before)) throw new CollaborationError("任务在恢复期间发生变化，请检查滴答后重试");
    const data = await request(owner, "/task/batch", { method: "POST", body: JSON.stringify({ update: [{ ...existing, status: 0, completedTime: null }] }) });
    if (data?.id2error?.[before.id]) throw new CollaborationError("滴答未接受恢复未完成，请稍后重试");
    const saved = await gateway.get(owner, before.id, before.projectId);
    if (!saved || saved.status || !sameFields(saved, before)) throw new CollaborationError("滴答尚未确认恢复未完成，请稍后重试");
    return saved;
  },
  async complete(owner, id, projectId) {
    if (projectId !== undefined && !validId(projectId)) throw new CollaborationError("清单编号无效", 400);
    await request(owner, `/project/${projectId ? encodeURIComponent(projectId) : "{inbox}"}/task/${encodeURIComponent(id)}/complete`, { method: "POST" });
  },
  async checkTransfer(owner, task) {
    if (task.parentId || ["attachments", "attachmentIds"].some(key => Array.isArray(task[key]) ? (task[key] as unknown[]).length > 0 : !!task[key])) throw new CollaborationError("此任务含父子关系或附件，暂不跨账户转移，原任务已保留");
    if (Array.isArray(task.focusSummaries) && task.focusSummaries.length) throw new CollaborationError("此任务含专注历史，暂不转移以保留原记录");
    const inbox = await gateway.inbox(owner);
    if (inbox.tasks.some(child => child.parentId === task.id)) throw new CollaborationError("此任务含子任务，请先整理关系后再转移");
    const comments = await request(owner, `/project/{inbox}/task/${encodeURIComponent(task.id)}/comments`);
    if (!Array.isArray(comments) || comments.length) throw new CollaborationError("此任务含评论或评论状态无法确认，暂不转移以保留原记录");
  },
};
