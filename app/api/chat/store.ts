import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeStoreFile } from '../store-file.ts';
import { fileStoreQueue } from '../store-queue.ts';

export type StoredAttachment = {
  id: string;
  url: string;
  name: string;
  size: number;
  mimeType: string;
  kind: "image" | "file" | "audio";
};

export type StoredQuote = { id: string; sender: string; body: string };

export type StoredMessage = {
  id: string;
  body: string;
  attachment?: StoredAttachment;
  replyTo?: StoredQuote;
  identityId: string;
  sender: string;
  time: string;
  createdAt: number;
  recalled?: boolean;
  recalledAt?: number;
};

type ChatStore = { version: 1; messages: StoredMessage[] };

const dataDirectory = process.env.DATA_DIR
  || (process.env.NODE_ENV === "production" ? "/data" : path.join(process.cwd(), ".data"));
const storePath = path.join(dataDirectory, "chat-messages.json");
const mutationQueue = fileStoreQueue(storePath);

async function readStore(): Promise<ChatStore> {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as Partial<ChatStore>;
    return { version: 1, messages: Array.isArray(parsed.messages) ? parsed.messages : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { version: 1, messages: [] };
  }
}

async function writeStore(store: ChatStore) {
  await writeStoreFile(storePath, `${JSON.stringify(store)}\n`);
}

async function mutate<T>(operation: (store: ChatStore) => Promise<T> | T): Promise<T> {
  return mutationQueue.run(async () => {
    const store = await readStore();
    const value = await operation(store);
    await writeStore(store);
    return value;
  });
}

export async function saveMessage(message: StoredMessage, onCreated?: () => void): Promise<StoredMessage> {
  return mutate((store) => {
    const existing = store.messages.find((item) => item.id === message.id);
    if (existing) {
      if (existing.identityId !== message.identityId) throw new Error("Message id belongs to another identity");
      return existing;
    }
    // Assign a strictly increasing server timestamp inside the serialized write.
    // Pagination must not skip messages created in the same millisecond.
    message.createdAt = store.messages.reduce((latest, item) => Math.max(latest, item.createdAt + 1, (item.recalledAt || 0) + 1), Date.now());
    store.messages.push(message);
    onCreated?.();
    return message;
  });
}

export async function recallMessage(id: string, identityId: string): Promise<boolean> {
  return mutate((store) => {
    const message = store.messages.find((item) => item.id === id && item.identityId === identityId);
    if (!message || message.recalled) return false;
    message.recalled = true;
    message.recalledAt = store.messages.reduce((latest, item) => Math.max(latest, item.createdAt + 1, (item.recalledAt || 0) + 1), Date.now());
    return true;
  });
}

export async function listMessageChanges(since: number, limit: number) {
  await mutationQueue.settled();
  const store = await readStore();
  const changes = store.messages
    .filter((message) => message.createdAt > since || (message.recalledAt || 0) > since)
    .sort((left, right) => {
      const leftChangedAt = Math.max(left.createdAt, left.recalledAt || 0);
      const rightChangedAt = Math.max(right.createdAt, right.recalledAt || 0);
      return leftChangedAt - rightChangedAt || left.id.localeCompare(right.id);
    });
  const boundary = changes[limit - 1];
  const boundaryTime = boundary ? Math.max(boundary.createdAt, boundary.recalledAt || 0) : Infinity;
  const page = changes.filter((message) => Math.max(message.createdAt, message.recalledAt || 0) <= boundaryTime);
  const cursor = page.reduce((latest, message) => Math.max(latest, message.createdAt, message.recalledAt || 0), since);
  return {
    messages: page.filter((message) => !message.recalled),
    recalledIds: page.filter((message) => message.recalled).map((message) => message.id),
    cursor,
    hasMore: changes.length > page.length,
  };
}

export async function listMessages(before: number | null, limit: number) {
  await mutationQueue.settled();
  const store = await readStore();
  const visible = store.messages
    .filter((message) => !message.recalled && (before === null || message.createdAt < before))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const start = Math.max(0, visible.length - limit);
  const boundaryTime = visible[start]?.createdAt || 0;
  const messages = visible.filter((message) => message.createdAt >= boundaryTime);
  const cursor = store.messages.reduce((latest, message) => Math.max(latest, message.createdAt, message.recalledAt || 0), 0);
  return { messages, nextCursor: start > 0 && messages[0] ? String(messages[0].createdAt) : null, cursor };
}

export async function sentAudioAttachment(id: string): Promise<StoredAttachment | null> {
  await mutationQueue.settled();
  const store = await readStore();
  return store.messages.find(message => !message.recalled && message.attachment?.id === id && message.attachment.kind === "audio")?.attachment || null;
}

export async function findMessage(id: string, identityId: string): Promise<StoredMessage | null> {
  await mutationQueue.settled();
  return (await readStore()).messages.find(message => message.id === id && message.identityId === identityId) || null;
}
