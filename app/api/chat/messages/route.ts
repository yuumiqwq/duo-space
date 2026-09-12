import { after, NextRequest, NextResponse } from "next/server";
import { currentIdentityId } from "../../identity/session";
import { getUser } from "../../identity/store";
import { listMessageChanges, listMessages, saveMessage, type StoredAttachment, type StoredQuote } from "../store";
import { sendChatPush } from "../../push/store";

export const runtime = "nodejs";

const idPattern = /^[0-9a-f-]{36}$/i;

function normalizeAttachment(value: unknown): StoredAttachment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<StoredAttachment>;
  if (typeof item.id !== "string" || !idPattern.test(item.id) || typeof item.url !== "string" || item.url !== `/api/chat/files/${item.id}`
    || typeof item.name !== "string" || typeof item.size !== "number" || !Number.isFinite(item.size) || item.size < 0
    || typeof item.mimeType !== "string" || (item.kind !== "image" && item.kind !== "file" && item.kind !== "audio")) return undefined;
  return { id: item.id, url: item.url, name: item.name.slice(0, 255), size: item.size, mimeType: item.mimeType.slice(0, 255), kind: item.kind };
}

function normalizeQuote(value: unknown): StoredQuote | undefined {
  if (!value || typeof value !== "object") return undefined;
  const quote = value as Partial<StoredQuote>;
  if (typeof quote.id !== "string" || typeof quote.sender !== "string" || typeof quote.body !== "string") return undefined;
  return { id: quote.id.slice(0, 80), sender: quote.sender.trim().slice(0, 24) || "成员", body: quote.body.trim().slice(0, 160) };
}

export async function GET(request: NextRequest) {
  if (!(await currentIdentityId())) return new NextResponse("Unauthorized", { status: 401 });
  const sinceText = request.nextUrl.searchParams.get("since");
  const since = sinceText && /^\d+$/.test(sinceText) ? Number(sinceText) : null;
  const beforeText = request.nextUrl.searchParams.get("before");
  const before = beforeText && /^\d+$/.test(beforeText) ? Number(beforeText) : null;
  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") || 30);
  const limit = Number.isFinite(requestedLimit) ? Math.min(200, Math.max(1, Math.floor(requestedLimit))) : 30;
  const result = since === null ? await listMessages(before, limit) : await listMessageChanges(since, limit);
  return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: NextRequest) {
  const identityId = await currentIdentityId();
  if (!identityId) return new NextResponse("Unauthorized", { status: 401 });
  const body = await request.json().catch(() => ({}));
  const id = typeof body.id === "string" && idPattern.test(body.id) ? body.id : crypto.randomUUID();
  const text = typeof body.body === "string" ? body.body.trim().slice(0, 8000) : "";
  const attachment = normalizeAttachment(body.attachment);
  if (!text && !attachment) return NextResponse.json({ error: "消息不能为空" }, { status: 400 });
  const user = await getUser(identityId);
  const now = Date.now();
  let created = false;
  const message = await saveMessage({
    id,
    body: text,
    attachment,
    replyTo: normalizeQuote(body.replyTo),
    identityId,
    sender: user?.nickname || identityId,
    time: new Date(now).toLocaleTimeString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }),
    createdAt: now,
  }, () => { created = true; });
  const senderDeviceId = (request.headers.get("x-device-id") || "").trim().slice(0, 80);
  if (created) after(() => sendChatPush(message, senderDeviceId).catch(() => {
    console.warn("chat-push", JSON.stringify({ messageId: message.id, status: "internal-error" }));
  }));
  return NextResponse.json({ message }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
