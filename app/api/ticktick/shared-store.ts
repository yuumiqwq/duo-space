import { readFile } from "node:fs/promises";
import { writeStoreFile } from '../store-file.ts';
import { fileStoreQueue } from '../store-queue.ts';
import path from "node:path";

export type SharedTaskRecord = {
  id: string; senderId: string; recipientId: string; senderName: string; title: string;
  state: "pending" | "confirmed" | "rejected"; createdAt: number; taskId?: string; projectId?: string; readAt?: number;
};
const directory = process.env.DATA_DIR || (process.env.NODE_ENV === "production" ? "/data" : path.join(process.cwd(), ".data"));
const file = path.join(directory, "shared-tasks.json");
const queue = fileStoreQueue(file);
async function read(): Promise<SharedTaskRecord[]> {
  try { return JSON.parse(await readFile(file, "utf8")) as SharedTaskRecord[]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function write(records: SharedTaskRecord[]) {
  await writeStoreFile(file, JSON.stringify(records));
}

export class SharedTaskError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export function createSharedTask(
  request: Pick<SharedTaskRecord, "id" | "senderId" | "recipientId" | "senderName" | "title">,
  create: () => Promise<{ taskId: string; projectId: string }>,
) {
  return queue.run(async () => {
    const records = await read();
    const existing = records.find(record => record.id === request.id);
    if (existing && (existing.senderId !== request.senderId || existing.recipientId !== request.recipientId || existing.title !== request.title)) throw new SharedTaskError("请求标识已被使用，请重新打开添加窗口。", 409);
    if (existing?.state === "confirmed") return existing;
    if (existing?.state === "pending") throw new SharedTaskError("上次提交结果尚未确认，请先让对方查看滴答收集箱，避免重复添加。", 409);
    const record: SharedTaskRecord = { ...request, createdAt: Date.now(), state: "pending" };
    if (existing) records.splice(records.indexOf(existing), 1, record); else records.push(record);
    // Persist before the external write. A process restart must not repeat an ambiguous POST.
    await write(records);
    try {
      const result = await create();
      Object.assign(record, result, { state: "confirmed" });
      await write(records);
      return record;
    } catch (error) {
      if (error instanceof SharedTaskError && error.status < 500) {
        record.state = "rejected";
        await write(records);
      }
      throw error;
    }
  });
}

export async function unreadSharedTasks(recipientId: string) {
  await queue.settled();
  return (await read()).filter(record => record.recipientId === recipientId && record.state === "confirmed" && !record.readAt);
}
export function markSharedTasksRead(recipientId: string, ids: string[]) {
  return queue.run(async () => {
    const records = await read();
    const selected = new Set(ids);
    for (const record of records) {
      if (record.recipientId === recipientId && record.state === "confirmed" && selected.has(record.id)) record.readAt ??= Date.now();
    }
    await write(records);
  });
}
