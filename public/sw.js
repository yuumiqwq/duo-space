self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", event => { event.waitUntil(self.clients.claim()); });

async function notificationsFor(tag) {
  try { return await self.registration.getNotifications({ tag }); }
  catch { return []; } // Notification lookup is optional; never lose a push over it.
}

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  if (!data || typeof data !== "object") data = {};
  const title = typeof data.title === "string" ? data.title : "11scat 新消息";
  const body = typeof data.body === "string" ? data.body : "自习室有一条新消息";
  const url = typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//") && !data.url.includes("\\") ? data.url : "/";
  event.waitUntil((async () => {
    const ring = data.kind === "ring" && typeof data.ringId === "string";
    const task = data.kind === "task" && typeof data.noticeId === "string";
    const chat = data.kind === "chat" && typeof data.messageId === "string";
    const tag = ring ? `11scat-ring-${data.ringId}` : task ? `11scat-task-${data.noticeId}` : chat ? `11scat-chat-${data.messageId}` : "11scat-room-message";
    const existing = await notificationsFor(tag);
    const duplicate = existing.length > 0 && (!ring || existing.some(notification => !data.repeat || (notification.data?.sequence || 0) >= (data.sequence || 1)));
    const ended = ring && (!Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now());
    // Safari requires EVERY push event to display a notification. Returning early
    // for duplicates/late rings can revoke the whole subscription, including chat.
    // Replace the existing tag without re-alerting, instead of dropping the event.
    await self.registration.showNotification(title, {
    body: ended ? "" : body,
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    tag,
    ...(duplicate || ended ? { silent: true } : task ? { vibrate: [200, 100, 200] } : {}),
    renotify: !duplicate && !ended && (!ring || !!data.repeat),
    ...(ring && !ended ? { actions: [{ action: "acknowledge", title: "知道了" }] } : {}),
    ...(ended && Number.isFinite(data.expiresAt) ? { timestamp: data.expiresAt } : {}),
    data: { url: ended ? "/" : url, ...(ring ? { ringId: data.ringId, sequence: Math.max(data.sequence || 1, ...existing.map(notification => notification.data?.sequence || 0)) } : {}) },
    });
    if (chat) {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      windows.forEach(client => client.postMessage({ type: "chat-updated" }));
    }
    // RoomBell clears ended rings when the user returns. Do not immediately
    // close a just-displayed notification from a background network request.
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let target = new URL("/", self.location.origin).href;
  try { const url = new URL(event.notification.data?.url || "/", self.location.origin); if (url.origin === self.location.origin) target = url.href; } catch { /* Open home for malformed legacy notifications. */ }
  event.waitUntil((async () => {
    if (event.action === "acknowledge" && event.notification.data?.ringId) {
      try {
        const response = await fetch("/api/room/rings", { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: event.notification.data.ringId, action: "acknowledge" }), signal: AbortSignal.timeout(8000) });
        if (response.ok) return;
      } catch { /* Open the room so the user can retry confirmation. */ }
    }
    return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const client = clients.find((item) => item.url.startsWith(self.location.origin));
    if (client) return client.focus().then(() => client.navigate(target));
    return self.clients.openWindow(target);
    });
  })());
});
