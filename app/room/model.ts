import { type MediaSource } from "../media-recovery";

export type Task = {
  id: string;
  projectId?: string;
  title: string;
  project: string;
  dueDate?: string;
  startDate?: string;
  isAllDay?: boolean;
  completedDay?: string;
  done: boolean;
  source: "ticktick" | "local";
};

export type ChatQuote = { id: string; sender: string; body: string };

export type ChatAttachment = { id: string; url: string; name: string; size: number; mimeType: string; kind: "image" | "file" | "audio" };

export type ChatMessage = { id: string; body: string; imageUrl?: string; attachment?: ChatAttachment; replyTo?: ChatQuote; identityId?: string; time: string; createdAt?: number; sender: string; own?: boolean; delivery?: "sending" | "failed"; pendingFileName?: string; error?: string };

export type OutgoingChat = { message: ChatMessage; file?: File; attachment?: ChatAttachment };

export type SharedTask = Pick<Task, "id" | "title" | "project" | "startDate" | "dueDate" | "done" | "isAllDay" | "completedDay">;

export type MediaItem = {
  id: string;
  label: string;
  stream: MediaStream;
  kind: MediaSource;
  remote: boolean;
};

export const USE_LIVEKIT = false;

export const MAX_REMOTE_DEVICES = 7;

export const chatImageUrlPattern = /^\/api\/chat\/(?:images|files)\/[0-9a-f-]{36}$/i;

export const MOBILE_BACKGROUND_GRACE_MS = 30 * 60 * 1000;

export const isMobileBrowser = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export const normalizeChatAttachment = (value: unknown): ChatAttachment | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<ChatAttachment>;
  if (typeof item.id !== "string" || typeof item.url !== "string" || item.url !== `/api/chat/files/${item.id}`
    || typeof item.name !== "string" || typeof item.size !== "number" || typeof item.mimeType !== "string"
    || (item.kind !== "image" && item.kind !== "file" && item.kind !== "audio")) return undefined;
  return { id: item.id, url: item.url, name: item.name, size: item.size, mimeType: item.mimeType, kind: item.kind };
};

export const validChatContent = (body: unknown, imageUrl: unknown, attachment?: unknown) => (
  (typeof body === "string" && body.trim().length > 0)
  || (typeof imageUrl === "string" && chatImageUrlPattern.test(imageUrl))
  || Boolean(normalizeChatAttachment(attachment))
);

export const formatFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
};

export const beijingTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export const formatChatTime = (message: ChatMessage) => (
  typeof message.createdAt === "number" && Number.isFinite(message.createdAt)
    ? beijingTimeFormatter.format(new Date(message.createdAt))
    : message.time
);

export const normalizeChatQuote = (value: unknown): ChatQuote | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const quote = value as Partial<ChatQuote>;
  if (typeof quote.id !== "string" || typeof quote.sender !== "string" || typeof quote.body !== "string") return undefined;
  return { id: quote.id.slice(0, 80), sender: quote.sender.trim().slice(0, 24) || "成员", body: quote.body.trim().slice(0, 160) };
};

export const normalizeIncomingMessage = (value: unknown, currentIdentityId: string): ChatMessage | null => {
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<ChatMessage>;
  const attachment = normalizeChatAttachment(message.attachment);
  if (typeof message.id !== "string" || typeof message.body !== "string" || typeof message.time !== "string" || typeof message.sender !== "string"
    || !validChatContent(message.body, message.imageUrl, attachment)) return null;
  const identityId = typeof message.identityId === "string" ? message.identityId.slice(0, 64) : undefined;
  return {
    id: message.id,
    body: message.body,
    imageUrl: typeof message.imageUrl === "string" && chatImageUrlPattern.test(message.imageUrl) ? message.imageUrl : undefined,
    attachment,
    replyTo: normalizeChatQuote(message.replyTo),
    identityId,
    time: message.time,
    createdAt: typeof message.createdAt === "number" ? message.createdAt : undefined,
    sender: message.sender.trim().slice(0, 24) || "成员",
    own: Boolean(identityId && identityId === currentIdentityId),
  };
};

export const mergeChatMessages = (incoming: ChatMessage[], current: ChatMessage[], recalled?: ReadonlySet<string>) => {
  const byId = new Map<string, ChatMessage>();
  [...current, ...incoming].forEach((message) => { if (!recalled?.has(message.id)) byId.set(message.id, message); });
  return [...byId.values()].sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0) || left.id.localeCompare(right.id));
};
