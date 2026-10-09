"use client";

import { Room } from "livekit-client";
import type { DataConnection } from "peerjs";
import type { RefObject } from "react";
import { FormEvent,useCallback,useEffect,useLayoutEffect,useRef,useState } from "react";
import { type ViewedChatImage } from "../ChatImageViewer";
import { type CloudSaveState } from "../CloudSaveButton";
import { confirmChatDelivery } from "../chat-delivery";
import { startChatSyncLifecycle } from "../chat-sync-lifecycle";
import { createChatSyncRequest } from "../chat-sync-request";
import { beijingTimeFormatter,ChatAttachment,ChatMessage,ChatQuote,mergeChatMessages,normalizeChatAttachment,normalizeIncomingMessage,OutgoingChat } from './model';

type Options = {
  sideView: "tasks" | "chat";
  classroomReady: boolean;
  identityIdRef: RefObject<string>;
  playNotificationSound: (messageId: string) => void;
  joined: boolean;
  roomRef: RefObject<Room | null>;
  dataConnectionsRef: RefObject<Map<string, DataConnection>>;
  pushDeviceIdRef: RefObject<string>;
  displayNameRef: RefObject<string>;
  displayName: string;
};

export function useRoomChat({ sideView, classroomReady, identityIdRef, playNotificationSound, joined, roomRef, dataConnectionsRef, pushDeviceIdRef, displayNameRef, displayName }: Options) {

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [chatImage, setChatImage] = useState<File | null>(null);
  const [chatImagePreview, setChatImagePreview] = useState("");
  const [viewedChatImage, setViewedChatImage] = useState<ViewedChatImage | null>(null);
  const [chatImageError, setChatImageError] = useState("");
  const [chatUploadProgress, setChatUploadProgress] = useState<number | null>(null);
  const [chatHistoryLoading, setChatHistoryLoading] = useState(false);
  const [chatHistoryCursor, setChatHistoryCursor] = useState<string | null>(null);
  const [chatHistoryReady, setChatHistoryReady] = useState(false);
  const [chatQuote, setChatQuote] = useState<ChatQuote | null>(null);
  const [messageMenuId, setMessageMenuId] = useState("");
  const [messageMenuPlacement, setMessageMenuPlacement] = useState<"above" | "below">("below");
  const [chatCloudUploads, setChatCloudUploads] = useState<Record<string, CloudSaveState>>({});
  const chatImageInputRef = useRef<HTMLInputElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressOriginRef = useRef({ x: 0, y: 0 });
  const longPressTriggeredRef = useRef(false);
  const chatAtBottomRef = useRef(true);
  const chatSavedScrollTopRef = useRef(0);
  const chatImageViewerOpenRef = useRef(false);
  const pendingHistoryScrollRef = useRef<{ height: number; top: number } | null>(null);
  const chatSyncCursorRef = useRef(0);
  const chatHistoryInitializedRef = useRef(false);
  const recalledChatIdsRef = useRef(new Set<string>());
  const chatSyncRequestRef = useRef(createChatSyncRequest());
  const outgoingChatRef = useRef(new Map<string, OutgoingChat>());
  const sendingChatIdsRef = useRef(new Set<string>());

  useEffect(() => () => {
    if (chatImagePreview) URL.revokeObjectURL(chatImagePreview);
  }, [chatImagePreview]);

  useEffect(() => () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
  }, []);

  useEffect(() => {
    if (!messageMenuId) return;
    const closeMenu = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest(".message-action-menu")) setMessageMenuId("");
    };
    document.addEventListener("pointerdown", closeMenu);
    return () => document.removeEventListener("pointerdown", closeMenu);
  }, [messageMenuId]);

  const scrollChatToBottom = useCallback((behavior: ScrollBehavior = "instant") => {
    if (chatImageViewerOpenRef.current) return;
    const list = messageListRef.current;
    if (list) {
      list.scrollTo({ top: list.scrollHeight, behavior });
      chatSavedScrollTopRef.current = list.scrollTop;
      chatAtBottomRef.current = true;
    }
  }, []);

  const openChatImage = (image: ViewedChatImage) => {
    const list = messageListRef.current;
    if (list) {
      // Stop an in-flight smooth scroll before recording the reading position.
      list.scrollTo({ top: list.scrollTop, behavior: "instant" });
      chatSavedScrollTopRef.current = list.scrollTop;
    }
    chatAtBottomRef.current = false;
    chatImageViewerOpenRef.current = true;
    setViewedChatImage(image);
  };

  const closeChatImage = () => {
    const list = messageListRef.current;
    if (list) {
      list.scrollTo({ top: chatSavedScrollTopRef.current, behavior: "instant" });
      chatAtBottomRef.current = list.scrollHeight - list.clientHeight - list.scrollTop <= 1;
    }
    chatImageViewerOpenRef.current = false;
    setViewedChatImage(null);
  };

  useLayoutEffect(() => {
    if (sideView !== "chat") return;
    const list = messageListRef.current;
    if (!list) return;
    const pending = pendingHistoryScrollRef.current;
    if (pending) {
      list.scrollTop = pending.top + (list.scrollHeight - pending.height);
      chatSavedScrollTopRef.current = list.scrollTop;
      pendingHistoryScrollRef.current = null;
      return;
    }
    if (chatAtBottomRef.current) scrollChatToBottom("auto");
    else list.scrollTop = chatSavedScrollTopRef.current;
  }, [messages, sideView, scrollChatToBottom, classroomReady]);

  const syncLatestChatMessages = useCallback(async (restart = false) => {
    if (!identityIdRef.current) return;
    const request = chatSyncRequestRef.current.begin(restart);
    if (!request) return;
    try {
      if (!chatHistoryInitializedRef.current) {
        const response = await fetch('/api/chat/messages?limit=30', { cache: 'no-store', signal: request.signal });
        if (!response.ok) throw new Error('无法加载聊天记录');
        const data = await response.json();
        if (!request.isCurrent()) return;
        const incoming = Array.isArray(data.messages) ? data.messages.map((item: unknown) => normalizeIncomingMessage(item, identityIdRef.current)).filter((item: ChatMessage | null): item is ChatMessage => Boolean(item)) : [];
        chatSyncCursorRef.current = typeof data.cursor === 'number' ? data.cursor : incoming.reduce((latest: number, message: ChatMessage) => Math.max(latest, message.createdAt || 0), 0);
        incoming.forEach((message: ChatMessage) => { if (message.own) outgoingChatRef.current.delete(message.id); });
        setMessages(current => mergeChatMessages(incoming, current, recalledChatIdsRef.current));
        setChatHistoryCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
        chatHistoryInitializedRef.current = true;
        return;
      }
      let cursor = chatSyncCursorRef.current;
      for (let page = 0; page < 4; page += 1) {
        const since = page === 0 ? Math.max(0, cursor - 1000) : cursor;
        const response = await fetch(`/api/chat/messages?since=${since}&limit=200`, { cache: "no-store", signal: request.signal });
        if (!response.ok) throw new Error("消息同步失败");
        const data = await response.json() as { messages?: unknown; recalledIds?: unknown; cursor?: unknown; hasMore?: unknown };
        if (!request.isCurrent() || request.signal.aborted) return;
        const incoming = Array.isArray(data.messages)
          ? data.messages.map((item) => normalizeIncomingMessage(item, identityIdRef.current)).filter((item): item is ChatMessage => Boolean(item))
          : [];
        const recalledIds = new Set(Array.isArray(data.recalledIds)
          ? data.recalledIds.filter((id): id is string => typeof id === "string")
          : []);
        recalledIds.forEach(id => { recalledChatIdsRef.current.add(id); outgoingChatRef.current.delete(id); });
        incoming.forEach(message => { if (message.own) outgoingChatRef.current.delete(message.id); });
        if (incoming.length || recalledIds.size) {
          setMessages((current) => {
            const remaining = recalledIds.size ? current.filter((message) => !recalledIds.has(message.id)) : current;
            const existingIds = new Set(remaining.map((message) => message.id));
            incoming.forEach((message) => {
              if (!message.own && !existingIds.has(message.id) && !recalledChatIdsRef.current.has(message.id)) playNotificationSound(message.id);
            });
            return mergeChatMessages(incoming, remaining, recalledChatIdsRef.current);
          });
          setChatQuote((current) => current && recalledIds.has(current.id) ? null : current);
        }
        const nextCursor = typeof data.cursor === "number" && Number.isFinite(data.cursor) ? data.cursor : cursor;
        cursor = Math.max(cursor, nextCursor);
        chatSyncCursorRef.current = cursor;
        if (data.hasMore !== true || nextCursor <= since) break;
      }
    } catch {
      // The peer data channel remains active; the next poll or focus event will retry server reconciliation.
    } finally {
      request.finish();
    }
  }, [playNotificationSound, identityIdRef]);

  const loadOlderChatMessages = async () => {
    if (chatHistoryLoading || !chatHistoryCursor) return;
    setChatHistoryLoading(true);
    try {
      const response = await fetch(`/api/chat/messages?limit=30&before=${encodeURIComponent(chatHistoryCursor)}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("无法加载更早消息");
      const data = await response.json() as { messages?: unknown; nextCursor?: unknown };
      const incoming = Array.isArray(data.messages)
        ? data.messages.map((item) => normalizeIncomingMessage(item, identityIdRef.current)).filter((item): item is ChatMessage => Boolean(item))
        : [];
      // Capture immediately before prepending, so messages received while the
      // request was pending cannot consume the history position adjustment.
      const list = messageListRef.current;
      if (list) pendingHistoryScrollRef.current = { height: list.scrollHeight, top: list.scrollTop };
      setMessages((current) => mergeChatMessages(incoming, current, recalledChatIdsRef.current));
      setChatHistoryCursor(typeof data.nextCursor === "string" ? data.nextCursor : null);
    } catch (error) {
      pendingHistoryScrollRef.current = null;
      setChatImageError(error instanceof Error ? error.message : "无法加载更早消息");
    } finally {
      setChatHistoryLoading(false);
    }
  };

  const handleChatScroll = () => {
    const list = messageListRef.current;
    if (!list) return;
    chatSavedScrollTopRef.current = list.scrollTop;
    chatAtBottomRef.current = list.scrollHeight - list.clientHeight - list.scrollTop <= 1;
    if (list.scrollTop <= 20 && chatHistoryCursor && !chatHistoryLoading) void loadOlderChatMessages();
  };

  useEffect(() => {
    if (!joined || chatHistoryReady || !identityIdRef.current) return;
    let disposed = false;
    const loadInitialChat = async () => {
      setChatHistoryLoading(true);
      try {
        const response = await fetch("/api/chat/messages?limit=30", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error("无法加载聊天记录");
        const data = await response.json() as { messages?: unknown; nextCursor?: unknown; cursor?: unknown };
        if (disposed) return;
        const incoming = Array.isArray(data.messages)
          ? data.messages.map((item) => normalizeIncomingMessage(item, identityIdRef.current)).filter((item): item is ChatMessage => Boolean(item))
          : [];
        chatSyncCursorRef.current = incoming.reduce((latest, message) => Math.max(latest, message.createdAt || 0), chatSyncCursorRef.current);
        if (typeof data.cursor === 'number' && Number.isFinite(data.cursor)) chatSyncCursorRef.current = Math.max(chatSyncCursorRef.current, data.cursor);
        incoming.forEach(message => { if (message.own) outgoingChatRef.current.delete(message.id); });
        setMessages((current) => mergeChatMessages(incoming, current, recalledChatIdsRef.current));
        setChatHistoryCursor(typeof data.nextCursor === "string" ? data.nextCursor : null);
        chatHistoryInitializedRef.current = true;
      } catch (error) {
        if (!disposed) setChatImageError(error instanceof Error ? error.message : "无法加载聊天记录");
      } finally {
        if (!disposed) { setChatHistoryLoading(false); setChatHistoryReady(true); }
      }
    };
    void loadInitialChat();
    return () => { disposed = true; };
  }, [joined, chatHistoryReady, identityIdRef]);

  useEffect(() => {
    if (!joined || !chatHistoryReady) return;
    const syncRequests = chatSyncRequestRef.current;
    return startChatSyncLifecycle({
      document, window, worker: navigator.serviceWorker,
      sync: syncLatestChatMessages, cancel: () => syncRequests.cancel(),
      setTimer: (callback, delay) => window.setTimeout(callback, delay),
      clearTimer: id => window.clearTimeout(id),
    });
  }, [chatHistoryReady, joined, syncLatestChatMessages]);

  const uploadChatImageToCloud = async (attachment: ChatAttachment) => {
    if (chatCloudUploads[attachment.id] === "uploading" || chatCloudUploads[attachment.id] === "done") return;
    setChatCloudUploads((current) => ({ ...current, [attachment.id]: "uploading" }));
    setChatImageError("");
    try {
      const response = await fetch("/api/cloud/import-chat", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ attachmentId: attachment.id }),
      });
      const result = await response.json().catch(() => null) as { error?: unknown } | null;
      if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "上传到云盘失败");
      setChatCloudUploads((current) => ({ ...current, [attachment.id]: "done" }));
    } catch (error) {
      setChatCloudUploads((current) => ({ ...current, [attachment.id]: "failed" }));
      setChatImageError(error instanceof Error ? error.message : "上传到云盘失败");
    }
  };

  const clearChatImage = () => {
    setChatImage(null);
    setChatImagePreview("");
    if (chatImageInputRef.current) chatImageInputRef.current.value = "";
  };

  const selectChatImage = (file?: File) => {
    setChatImageError("");
    if (!file) return;
    setChatImage(file);
    setChatImagePreview(file.type.startsWith("image/") ? URL.createObjectURL(file) : "");
  };

  const uploadChatFile = (file: File) => new Promise<ChatAttachment>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/chat/files");
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.setRequestHeader("X-File-Name", encodeURIComponent(file.name || "file"));
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) setChatUploadProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    });
    request.addEventListener("load", () => {
      const result = (() => { try { return JSON.parse(request.responseText) as { attachment?: unknown; error?: unknown; cloudWarning?: unknown }; } catch { return null; } })();
      const attachment = normalizeChatAttachment(result?.attachment);
      if (request.status >= 200 && request.status < 300 && attachment) {
        setChatUploadProgress(100);
        if (typeof result?.cloudWarning === "string") setChatImageError(result.cloudWarning);
        resolve(attachment);
      } else reject(new Error(typeof result?.error === "string" ? result.error : "附件上传失败，请重试"));
    });
    request.addEventListener("error", () => reject(new Error("附件上传失败，请检查网络后重试")));
    request.addEventListener("abort", () => reject(new Error("附件上传已中断")));
    request.timeout = 120_000;
    request.addEventListener("timeout", () => reject(new Error("附件上传超时，请重试")));
    request.send(file);
  });

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current === null) return;
    window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };

  const startMessageLongPress = (event: React.PointerEvent, messageId: string) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as Element).closest("button, a, audio, input")) { clearLongPressTimer(); longPressTriggeredRef.current = false; return; }
    clearLongPressTimer();
    longPressTriggeredRef.current = false;
    longPressOriginRef.current = { x: event.clientX, y: event.clientY };
    const messageTop = event.currentTarget.getBoundingClientRect().top;
    const listTop = messageListRef.current?.getBoundingClientRect().top || 0;
    const placement = messageTop - listTop > 145 ? "above" : "below";
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      setMessageMenuPlacement(placement);
      setMessageMenuId(messageId);
      longPressTimerRef.current = null;
    }, 520);
  };

  const moveMessageLongPress = (event: React.PointerEvent) => {
    if (Math.hypot(event.clientX - longPressOriginRef.current.x, event.clientY - longPressOriginRef.current.y) > 8) clearLongPressTimer();
  };

  const recallMessage = async (message: ChatMessage) => {
    if (!message.own) return;
    setMessageMenuId("");
    const response = await fetch(`/api/chat/messages/${encodeURIComponent(message.id)}`, { method: "DELETE", signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!response?.ok) {
      setChatImageError("撤回失败，请重试");
      return;
    }
    recalledChatIdsRef.current.add(message.id);
    outgoingChatRef.current.delete(message.id);
    setMessages((current) => current.filter((item) => item.id !== message.id));
    if (chatQuote?.id === message.id) setChatQuote(null);
    void roomRef.current?.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ type: "chat-recall", id: message.id })),
      { reliable: true },
    );
    dataConnectionsRef.current.forEach((connection) => {
      if (connection.open) connection.send({ type: "chat-recall", id: message.id });
    });
  };

  const quoteMessage = (message: ChatMessage) => {
    const attachmentLabel = message.attachment ? `[${message.attachment.kind === "image" ? "图片" : message.attachment.kind === "audio" ? "语音" : `文件：${message.attachment.name}`}]` : "[图片]";
    setChatQuote({ id: message.id, sender: message.sender, body: (message.body || attachmentLabel).slice(0, 160) });
    setMessageMenuId("");
  };

  const copyMessage = async (message: ChatMessage) => {
    const attachmentUrl = message.attachment?.url || message.imageUrl;
    const text = message.body || (attachmentUrl ? `${window.location.origin}${attachmentUrl}` : "");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt("复制消息", text);
    }
    setMessageMenuId("");
  };

  const deliverChat = async (item: OutgoingChat) => {
    const { id } = item.message;
    if (sendingChatIdsRef.current.has(id)) return;
    sendingChatIdsRef.current.add(id);
    setMessages((current) => current.map((message) => message.id === id ? { ...message, delivery: "sending", error: undefined } : message));
    try {
      if (!item.attachment && item.file) item.attachment = await uploadChatFile(item.file);
      const result = await confirmChatDelivery({ id, body: item.message.body, attachment: item.attachment, replyTo: item.message.replyTo }, pushDeviceIdRef.current, {
        confirmed: () => !outgoingChatRef.current.has(id),
      });
      if (!result) return;
      if (result.recalled) {
        recalledChatIdsRef.current.add(id); outgoingChatRef.current.delete(id);
        setMessages(current => current.filter(message => message.id !== id));
        return;
      }
      const message = normalizeIncomingMessage(result?.message, identityIdRef.current);
      if (!message) throw new Error("发送未确认，请重试");
      setMessages((current) => mergeChatMessages([message], current, recalledChatIdsRef.current));
      outgoingChatRef.current.delete(id);
      // Delivery is already durable. A disconnected peer must not turn success into failure.
      void roomRef.current?.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ ...message, type: "chat" })), { reliable: true }).catch(() => undefined);
      dataConnectionsRef.current.forEach((connection) => {
        try { if (connection.open) connection.send({ ...message, type: "chat" }); } catch { /* Server reconciliation retries delivery. */ }
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "发送未确认，请重试";
      setMessages((current) => current.map((message) => message.id === id && message.delivery ? { ...message, delivery: "failed", error: reason } : message));
    } finally {
      sendingChatIdsRef.current.delete(id);
      if (!sendingChatIdsRef.current.size) setChatUploadProgress(null);
    }
  };

  const sendVoice = (file: File) => {
    const now = Date.now();
    const message: ChatMessage = {
      id: crypto.randomUUID(), body: "", pendingFileName: file.name, replyTo: chatQuote || undefined,
      identityId: identityIdRef.current, sender: displayNameRef.current || displayName,
      time: beijingTimeFormatter.format(now), createdAt: now, own: true, delivery: "sending",
    };
    const item: OutgoingChat = { message, file };
    outgoingChatRef.current.set(message.id, item);
    setChatQuote(null); setChatImageError("");
    setMessages(current => mergeChatMessages([message], current));
    void deliverChat(item);
  };

  const sendMessage = (event: FormEvent) => {
    event.preventDefault();
    const body = chatDraft.trim();
    if (!body && !chatImage) return;
    const now = Date.now();
    const message: ChatMessage = {
      id: crypto.randomUUID(), body, pendingFileName: chatImage?.name, replyTo: chatQuote || undefined,
      identityId: identityIdRef.current, sender: displayNameRef.current || displayName,
      time: beijingTimeFormatter.format(now), createdAt: now, own: true, delivery: "sending",
    };
    const item: OutgoingChat = { message, file: chatImage || undefined };
    outgoingChatRef.current.set(message.id, item);
    setChatDraft("");
    setChatQuote(null);
    clearChatImage();
    setChatImageError("");
    setMessages((current) => mergeChatMessages([message], current));
    void deliverChat(item);
  };
  return { messages, setMessages, chatDraft, setChatDraft, chatImage, chatImagePreview, viewedChatImage, chatImageError, setChatImageError, chatUploadProgress, chatHistoryLoading, chatHistoryCursor, chatHistoryReady, chatQuote, setChatQuote, messageMenuId, setMessageMenuId, messageMenuPlacement, setMessageMenuPlacement, chatCloudUploads, chatImageInputRef, messageListRef, longPressTriggeredRef, chatAtBottomRef, recalledChatIdsRef, outgoingChatRef, scrollChatToBottom, openChatImage, closeChatImage, handleChatScroll, uploadChatImageToCloud, clearChatImage, selectChatImage, clearLongPressTimer, startMessageLongPress, moveMessageLongPress, recallMessage, quoteMessage, copyMessage, deliverChat, sendVoice, sendMessage };
}
