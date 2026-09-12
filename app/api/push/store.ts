import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import webPush from "web-push";
import { receivesTaskNotice, type TaskNotice } from "../../collaboration-notifications";
import { getUser, listRoomMembers } from "../identity/store";
import { chatPushPayload, deliverChatNotification } from "./delivery";

export type StoredPushSubscription = {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
  identityId: string;
  deviceId: string;
  updatedAt: number;
};

type PushStore = { version: 1; subscriptions: StoredPushSubscription[] };
const dataDirectory = process.env.DATA_DIR
  || (process.env.NODE_ENV === "production" ? "/data" : path.join(process.cwd(), ".data"));
const storePath = path.join(dataDirectory, "push-subscriptions.json");
let mutationQueue: Promise<void> = Promise.resolve();

async function readStore(): Promise<PushStore> {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as Partial<PushStore>;
    return { version: 1, subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { version: 1, subscriptions: [] };
  }
}

async function writeStore(store: PushStore) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(store)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, storePath);
}

async function mutate(operation: (store: PushStore) => void | Promise<void>) {
  const next = mutationQueue.then(async () => {
    const store = await readStore();
    await operation(store);
    await writeStore(store);
  });
  mutationQueue = next.catch(() => undefined);
  return next;
}

export function savePushSubscription(subscription: StoredPushSubscription) {
  return mutate((store) => {
    const index = store.subscriptions.findIndex((item) => item.endpoint === subscription.endpoint);
    if (index >= 0) store.subscriptions[index] = subscription;
    else store.subscriptions.push(subscription);
    store.subscriptions = store.subscriptions.filter((item) => item.updatedAt >= Date.now() - 180 * 24 * 60 * 60 * 1000);
  });
}

export function removePushSubscription(endpoint: string, identityId?: string) {
  return mutate((store) => { store.subscriptions = store.subscriptions.filter((item) => item.endpoint !== endpoint || (identityId !== undefined && item.identityId !== identityId)); });
}

export async function sendDeviceTestPush(identityId: string, endpoint: string) {
  const publicKey = process.env.VAPID_PUBLIC_KEY, privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return { status: 503, error: "服务器尚未完整配置消息推送" };
  await mutationQueue;
  const subscription = (await readStore()).subscriptions.find(item => item.endpoint === endpoint && item.identityId === identityId);
  if (!subscription) return { status: 404, error: "服务器没有此设备的订阅，请重新开启提醒" };
  webPush.setVapidDetails(process.env.VAPID_SUBJECT || "https://study.11scat.xyz", publicKey, privateKey);
  try {
    await webPush.sendNotification(subscription, JSON.stringify({
      title: "11scat 测试提醒", body: "如果你看到了这条系统通知，此设备现在可以收到推送提醒。", url: "/",
    }), { TTL: 60, urgency: "high", timeout: 10_000 });
    return { status: 200 };
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      await removePushSubscription(endpoint);
      return { status: 410, error: "此设备订阅已过期，请关闭提醒后重新开启" };
    }
    console.warn("test-push", JSON.stringify({ provider: new URL(endpoint).hostname, status: status || "network-error" }));
    return { status: 502, error: "推送服务未接受测试通知，请检查服务器网络和推送密钥配置" };
  }
}

export async function sendChatPush(message: { id?: string; sender: string; body: string; attachment?: { kind: string; name: string } }, senderDeviceId: string) {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) { console.warn("chat-push", JSON.stringify({ messageId: message.id, status: "unconfigured" })); return; }
  webPush.setVapidDetails(process.env.VAPID_SUBJECT || "https://study.11scat.xyz", publicKey, privateKey);
  await mutationQueue;
  const store = await readStore();
  const payload = chatPushPayload(message);
  const expired = new Set<string>();
  const members = new Set((await listRoomMembers()).map(member => member.id));
  const recipients = store.subscriptions.filter((item) => item.deviceId !== senderDeviceId && members.has(item.identityId));
  let accepted = 0, failed = 0;
  await Promise.allSettled(recipients.map(async (item) => {
    try {
      const response = await deliverChatNotification({ endpoint: item.endpoint, expirationTime: item.expirationTime, keys: item.keys }, payload);
      accepted++;
      console.info("chat-push", JSON.stringify({ messageId: message.id, provider: new URL(item.endpoint).hostname, status: response.statusCode }));
    } catch (error) {
      failed++;
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) expired.add(item.endpoint);
      console.warn("chat-push", JSON.stringify({ messageId: message.id, provider: new URL(item.endpoint).hostname, status: statusCode || "network-error" }));
    }
  }));
  if (expired.size) await mutate((current) => { current.subscriptions = current.subscriptions.filter((item) => !expired.has(item.endpoint)); });
  console.info("chat-push", JSON.stringify({ messageId: message.id, accepted, failed, recipients: recipients.length }));
}

export async function sendTaskPush(notice: TaskNotice) {
  const publicKey = process.env.VAPID_PUBLIC_KEY, privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return;
  webPush.setVapidDetails(process.env.VAPID_SUBJECT || "https://study.11scat.xyz", publicKey, privateKey);
  await mutationQueue;
  const members = new Set((await listRoomMembers()).map(member => member.id));
  const name = notice.actorId ? (await getUser(notice.actorId))?.nickname || "同桌" : "任务板";
  const payload = JSON.stringify({ kind: "task", noticeId: notice.id, title: `${name} · ${notice.title}`, body: notice.body, url: notice.workflowId ? `/?taskboard=1&workflow=${encodeURIComponent(notice.workflowId)}` : "/?taskboard=1" });
  const subscriptions = (await readStore()).subscriptions.filter(item => members.has(item.identityId) && receivesTaskNotice(notice, item.identityId));
  const expired = new Set<string>();
  await Promise.allSettled(subscriptions.map(async item => {
    try { await webPush.sendNotification({ endpoint: item.endpoint, expirationTime: item.expirationTime, keys: item.keys }, payload, { TTL: 60 * 60, urgency: "high", timeout: 10_000 }); }
    catch (error) { if ([404, 410].includes((error as { statusCode?: number }).statusCode || 0)) expired.add(item.endpoint); }
  }));
  if (expired.size) await mutate(store => { store.subscriptions = store.subscriptions.filter(item => !expired.has(item.endpoint)); });
}

export async function sendRingPush(ring: { id: string; recipientId: string; senderName: string; expiresAt: number; repeat?: boolean; attempts?: number }): Promise<"accepted" | "unavailable" | "failed"> {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return "unavailable";
  webPush.setVapidDetails(process.env.VAPID_SUBJECT || "https://study.11scat.xyz", publicKey, privateKey);
  await mutationQueue;
  const subscriptions = (await readStore()).subscriptions.filter(item => item.identityId === ring.recipientId);
  if (!subscriptions.length) return "unavailable";
  const payload = JSON.stringify({ kind: "ring", ringId: ring.id, sequence: ring.attempts || 1, repeat: !!ring.repeat, expiresAt: ring.expiresAt, title: `${ring.senderName} 摇了摇铃`, body: "有空看一下自习室，点击确认。", url: "/?ring=1" });
  const expired = new Set<string>();
  const results = await Promise.all(subscriptions.map(async item => {
    try {
      const ttl = Math.min(3, Math.floor((ring.expiresAt - Date.now()) / 1000));
      if (ttl <= 0) return false;
      const response = await webPush.sendNotification({ endpoint: item.endpoint, expirationTime: item.expirationTime, keys: item.keys }, payload, { TTL: ttl, urgency: "high", timeout: 2500 });
      console.info("ring-push", JSON.stringify({ ringId: ring.id, provider: new URL(item.endpoint).hostname, status: response.statusCode }));
      return true;
    } catch (error) {
      console.warn("ring-push", JSON.stringify({ ringId: ring.id, provider: new URL(item.endpoint).hostname, status: (error as { statusCode?: number }).statusCode || "network-error" }));
      if ([404, 410].includes((error as { statusCode: number }).statusCode)) expired.add(item.endpoint);
      return false;
    }
  }));
  if (expired.size) await mutate(current => { current.subscriptions = current.subscriptions.filter(item => !expired.has(item.endpoint)); });
  return results.some(Boolean) ? "accepted" : "failed";
}
