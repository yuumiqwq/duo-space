import { NextResponse } from "next/server";
import { currentIdentityId } from "../../identity/session";
import { getUser } from "../../identity/store";
import { decryptToken } from "../crypto";
import { tickFetch, resolveTickInbox, TickApiError } from "../client";
import { createSharedTask, markSharedTasksRead, SharedTaskError, unreadSharedTasks } from "../shared-store";

const noStore = { "Cache-Control": "private, no-store" };
export async function GET() {
  const identityId = await currentIdentityId();
  if (!identityId) return new NextResponse("Unauthorized", { status: 401 });
  return NextResponse.json({ tasks: await unreadSharedTasks(identityId) }, { headers: noStore });
}
export async function PATCH(request: Request) {
  const identityId = await currentIdentityId();
  if (!identityId) return new NextResponse("Unauthorized", { status: 401 });
  const body = await request.json().catch(() => null);
  if (!Array.isArray(body?.ids) || body.ids.length > 1000 || body.ids.some((id: unknown) => typeof id !== "string" || id.length > 80)) return new NextResponse("Invalid records", { status: 400 });
  await markSharedTasksRead(identityId, body.ids);
  return NextResponse.json({ ok: true }, { headers: noStore });
}
export async function POST(request: Request) {
  const senderId = await currentIdentityId();
  if (!senderId) return new NextResponse("Unauthorized", { status: 401 });
  const body = await request.json().catch(() => null);
  const recipientId = body?.recipientId;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (typeof recipientId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(recipientId) || recipientId === senderId
    || typeof body?.id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.id) || !title || title.length > 500) return NextResponse.json({ error: "请指定另一位成员并填写 1 至 500 字的待办。" }, { status: 400 });
  const [sender, recipient] = await Promise.all([getUser(senderId), getUser(recipientId)]);
  if (!sender || !recipient) return NextResponse.json({ error: "成员不存在。" }, { status: 404 });
  if (!recipient.ticktickToken) return NextResponse.json({ error: "对方尚未连接滴答清单。" }, { status: 422 });
  let token: string;
  try { token = decryptToken(recipient.ticktickToken); }
  catch { return NextResponse.json({ error: "对方需要重新连接滴答清单。" }, { status: 422 }); }
  try {
    // Reads may be retried freely. Resolve the recipient's inbox before recording a write attempt.
    const { projectId: inboxId } = await resolveTickInbox(token);
    if (inboxId === "inbox") return NextResponse.json({ error: "对方收集箱为空且未返回具体编号，请先在其收集箱添加一项后刷新。" }, { status: 422 });
    const record = await createSharedTask({ id: body.id, senderId, recipientId, senderName: sender.nickname || "成员", title }, async () => {
      const response = await tickFetch("/task", token, { method: "POST", body: JSON.stringify({ title, projectId: inboxId, timeZone: "Asia/Shanghai", isAllDay: true }) });
      if (!response.ok) throw new SharedTaskError(response.status < 500 ? "滴答未接受待办，请检查对方连接后重试。" : "滴答暂时无法确认结果，请先查看对方收集箱。", response.status < 500 ? 422 : 502);
      const task = await response.json();
      if (typeof task?.id !== "string" || task.projectId !== inboxId) throw new Error("Unexpected task result");
      return { taskId: task.id, projectId: inboxId };
    });
    return NextResponse.json({ task: record }, { status: 201, headers: noStore });
  } catch (error) {
    if (error instanceof TickApiError) return NextResponse.json({ error: error.message }, { status: [401, 403].includes(error.status) ? 422 : 502 });
    return NextResponse.json({ error: error instanceof SharedTaskError ? error.message : "提交结果未确认，请先让对方查看收集箱，避免重复添加。" }, { status: error instanceof SharedTaskError ? error.status : 502 });
  }
}
