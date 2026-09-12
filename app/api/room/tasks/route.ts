import { after, NextRequest, NextResponse } from "next/server";
import { currentIdentityId } from "../../identity/session";
import { getUser } from "../../identity/store";
import { CollaborationError, collectionOperation, isPersonalCollection } from "./store";
import { store } from "./service";

export const runtime = "nodejs";
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
async function identity() { const id = await currentIdentityId(); return id && await getUser(id) ? id : null; }
export async function GET(request: NextRequest) {
  const id = await identity();
  if (!id) return json({ error: "请先登录自习室" }, 401);
  try {
    // Migrate when the active server receives member traffic. Deployment candidates
    // share the data mount, so startup/health checks must never mutate this store.
    const local = request.nextUrl.searchParams.has("local"), member = request.nextUrl.searchParams.get("member");
    const revision = request.nextUrl.searchParams.has("revision");
    if (!local && member === null && !revision) await store.resetLegacy(id);
    after(async () => { await store.resetLegacy(id).catch(() => undefined); await store.maintainWorkflows().catch(() => undefined); });
    const diagnostic = request.nextUrl.searchParams.get("diagnose");
    return json(diagnostic !== null ? await store.inspectTransfer(id, diagnostic) : revision ? await store.revision(id) : await store.snapshot(id, local ? null : member ?? undefined));
  }
  catch (error) { return json({ error: error instanceof CollaborationError ? error.message : "协作区暂时无法读取，请重试" }, error instanceof CollaborationError ? error.status : 503); }
}
export async function POST(request: NextRequest) {
  const actor = await identity();
  if (!actor) return json({ error: "请先登录自习室" }, 401);
  const origin = request.headers.get("origin");
  if (origin) { try { if (new URL(origin).host !== request.headers.get("host")) return json({ error: "无效来源" }, 403); } catch { return json({ error: "无效来源" }, 403); } }
  try {
    const text = await request.text();
    if (text.length > 64000) return json({ error: "任务内容过长" }, 413);
    const command = JSON.parse(text);
    if (!command || typeof command !== "object") return json({ error: "操作无效" }, 400);
    if (command.action === "read-notices") return json(await store.markNoticesRead(actor, command.ids));
    if (command.action === "arrange-execution") return json(await store.arrangeExecution(actor, command));
    after(() => store.deliverNotices().catch(() => undefined));
    if (command.action === "legacy-reset") return json(await store.resetLegacy(actor));
    if (command.action === "claim" || ["submit", "approve", "reject", "retry-workflow", "owner-complete", "update-workflow", "restore-workflow", "delete-claimed-task", "delete-owner-task", "nudge", "reply-nudge"].includes(command.action)) {
      const workflow = command.action === "claim" ? await store.claim(actor, command) : await store.workflowCommand(actor, command);
      if (isPersonalCollection(workflow)) return json({ operation: collectionOperation(workflow) }, workflow.error ? 202 : 200);
      return json({ workflow }, workflow.error || workflow.syncError ? 202 : 200);
    }
    const result = command.action === "recover" ? await store.recover() : command.action === "resume" || command.action === "cancel"
      ? await store.resume(actor, typeof command.id === "string" ? command.id : "", command.action === "cancel")
      : await store.execute(actor, command);
    return json({ operation: result }, result.status === "pending" ? 202 : 200);
  } catch (error) {
    return json({ error: error instanceof CollaborationError ? error.message : error instanceof SyntaxError ? "操作格式无效" : "协作操作暂未完成，请刷新后核对状态" }, error instanceof CollaborationError ? error.status : error instanceof SyntaxError ? 400 : 503);
  }
}
