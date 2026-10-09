import { mkdir, readFile, rename, writeFile, rmdir, stat } from "node:fs/promises";
import path from "node:path";

export type Ring = {
  id: string; senderId: string; recipientId: string; senderName: string; recipientName: string;
  createdAt: number; expiresAt: number; updatedAt: number;
  state: "active" | "acknowledged" | "cancelled" | "expired";
  delivery: "pending" | "accepted" | "unavailable" | "failed";
  repeat?: boolean; attempts?: number; nextAttemptAt?: number;
};
const directory = process.env.DATA_DIR || (process.env.NODE_ENV === "production" ? "/data" : path.join(process.cwd(), ".data"));
const filename = path.join(/* turbopackIgnore: true */ directory, "rings.json");
let queue: Promise<unknown> = Promise.resolve();
export class RingError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
async function read(): Promise<Ring[]> {
  try { return JSON.parse(await readFile(filename, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function transact<T>(operation: (records: Ring[]) => T): Promise<T> {
  const next = queue.then(async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = `${filename}.lock`;
    for (;;) {
      try { await mkdir(lock); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const details = await stat(lock).catch(() => null);
        if (details && Date.now() - details.mtimeMs > 30000) await rmdir(lock).catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try {
    const records = await read();
    const result = operation(records);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(records), { mode: 0o600 });
    await rename(temporary, filename);
    return result;
    } finally { await rmdir(lock); }
  });
  queue = next.catch(() => undefined);
  return next;
}
function current(ring: Ring, now: number): Ring {
  return ring.state === "active" && ring.expiresAt <= now
    ? { ...ring, state: "expired", updatedAt: ring.expiresAt } : ring;
}
export async function listRings(identityId: string, now = Date.now()): Promise<Ring[]> {
  await queue;
  return (await read()).filter(r => r.senderId === identityId || r.recipientId === identityId)
    .filter(r => r.createdAt >= now - 24 * 60 * 60 * 1000).map(r => current(r, now))
    .sort((a, b) => b.createdAt - a.createdAt);
}
export function startRing(input: Pick<Ring, "id" | "senderId" | "recipientId" | "senderName" | "recipientName">, now = Date.now()) {
  return transact(records => {
    if (input.senderId === input.recipientId) throw new RingError("不能向自己摇铃", 400);
    const duplicate = records.find(r => r.id === input.id);
    if (duplicate) {
      if (duplicate.senderId !== input.senderId || duplicate.recipientId !== input.recipientId) throw new RingError("提醒编号已使用", 409);
      return { ring: current(duplicate, now), created: false };
    }
    const active = records.find(r => r.senderId === input.senderId && r.recipientId === input.recipientId && current(r, now).state === "active");
    if (active) return { ring: active, created: false };
    if (records.some(r => r.senderId === input.senderId && now - r.createdAt < 30_000)) throw new RingError("请稍等 30 秒再摇铃", 429);
    const ring: Ring = { ...input, createdAt: now, updatedAt: now, expiresAt: now + 120_000, state: "active", delivery: "pending", repeat: true, attempts: 0, nextAttemptAt: now };
    records.push(ring);
    // Keep recent tombstones so delayed requests cannot restart an ended ring.
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    for (let i = records.length - 1; i >= 0; i--) if (records[i].createdAt < cutoff) records.splice(i, 1);
    return { ring, created: true };
  });
}
export function finishRing(id: string, identityId: string, action: "acknowledge" | "cancel", now = Date.now()) {
  return transact(records => {
    const index = records.findIndex(r => r.id === id);
    if (index < 0) throw new RingError("提醒不存在", 404);
    const ring = current(records[index], now);
    if ((action === "acknowledge" ? ring.recipientId : ring.senderId) !== identityId) throw new RingError("不能修改他人的提醒", 403);
    if (ring.state !== "active") return ring;
    records[index] = { ...ring, state: action === "acknowledge" ? "acknowledged" : "cancelled", updatedAt: now };
    return records[index];
  });
}
export function setRingDelivery(id: string, delivery: Ring["delivery"]) {
  return transact(records => { const ring = records.find(r => r.id === id); if (ring) ring.delivery = delivery; });
}

export async function claimDueRings(now = Date.now()) {
  await queue;
  if (!(await read()).some(ring => ring.repeat && current(ring, now).state === "active" && (ring.attempts || 0) < 40 && (ring.nextAttemptAt || 0) <= now)) return [];
  return transact(records => {
    const due: Ring[] = [];
    for (const ring of records) {
      if (!ring.repeat || current(ring, now).state !== "active" || (ring.attempts || 0) >= 40 || (ring.nextAttemptAt || 0) > now) continue;
      ring.attempts = (ring.attempts || 0) + 1;
      // Persist before sending. Restart skips missed intervals, never catches up in a burst.
      ring.nextAttemptAt = now + 3000;
      due.push({ ...ring });
    }
    return due;
  });
}
