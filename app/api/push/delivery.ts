import webPush from "web-push";
import { setTimeout as delay } from "node:timers/promises";

export function chatPushPayload(message: { id?: string; sender: string; body: string; attachment?: { kind: string; name: string } }) {
  // Bound code points before JSON encoding, including escaped control characters.
  // RFC 8291 guarantees only 3993 plaintext bytes for a 4096-byte push.
  const preview = (value: string, limit: number) => {
    const characters = Array.from(value);
    return characters.length > limit ? characters.slice(0, limit).join("") + "…" : value;
  };
  return JSON.stringify({
    kind: "chat", messageId: message.id,
    title: `${preview(message.sender, 64)} 发来消息`,
    body: preview(message.body || (message.attachment?.kind === "image" ? "发送了一张图片" : message.attachment?.kind === "audio" ? "发送了一条语音" : `发送了文件：${message.attachment?.name || "文件"}`), 240),
    url: "/",
  });
}

export async function deliverChatNotification(subscription: webPush.PushSubscription, payload: string, sleep = delay) {
  for (let attempt = 0; ; attempt++) {
    try { return await webPush.sendNotification(subscription, payload, { TTL: 60 * 60, urgency: "high", timeout: 10_000 }); }
    catch (error) {
      const failure = error as { statusCode?: number; headers?: Record<string, string> };
      const status = failure.statusCode;
      if (attempt >= 2 || (status !== undefined && status !== 429 && status < 500)) throw error;
      const retryAfter = failure.headers?.["retry-after"];
      const requestedDelay = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
      // Never retry earlier than the provider asks. Long backoffs require a later send.
      if (requestedDelay > 30_000) throw error;
      await sleep(Math.max(500 * 2 ** attempt, Number.isFinite(requestedDelay) ? requestedDelay : 0));
    }
  }
}
