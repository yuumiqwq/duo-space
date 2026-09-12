"use client";

import { AudioPlayer } from "./AudioPlayer";
import { RemoteMicrophone } from "./RemoteMicrophone";
import { prepareClassroomAssets } from './classroom-loading';
import { RoomLoadingScreen } from './RoomLoadingScreen';
import { createChatSyncRequest } from "./chat-sync-request";
import { startChatSyncLifecycle } from "./chat-sync-lifecycle";
import { decodeVapidKey, subscriptionNeedsRenewal } from "./push-subscription";

import { FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Camera, ChevronLeft, ChevronRight, Volume2, VolumeX, X, Paperclip, File, Download, Undo2, Quote, Copy, Check, PictureInPicture2, MessageCircle, ListTodo } from "lucide-react";
import { Room, RoomEvent, Track } from "livekit-client";
import { createMediaRecovery, mediaCallReusable, type MediaSource } from "./media-recovery";
import type { DataConnection, MediaConnection, Peer as PeerClient, PeerOptions } from "peerjs";
import { BoardStroke, BoardText, RoomBoard, Whiteboard } from "./Whiteboard";
import { INITIAL_BOARD_EPOCH, normalizeBoardStroke, normalizeBoardText, normalizeBoard, sortBoardStrokes, mergeBoard } from "./board-state";
import { encodeRoomPackets, createPacketReceiver } from "./room-packets";
import { VoiceRecorder } from "./VoiceRecorder";
import { CloudSaveButton, type CloudSaveState } from "./CloudSaveButton";
import { ChatImageViewer, type ViewedChatImage } from "./ChatImageViewer";
import { NewMemberTasks } from "./MemberTasks";
import { RoomCollaboration } from "./RoomCollaboration";
import { TickTickDiagnostics } from "./TickTickDiagnostics";
import { RoomBell } from "./RoomBell";
import { CloudDrive } from "./CloudDrive";
import type { CloudStatus } from "./cloud-drive-actions";
import { useMainFullscreen } from "./use-main-fullscreen";
import "./main-fullscreen.css";
import "./classroom.css";
import { BlackboardSurface, ClassroomFullscreenIcon, ClassroomProp, EmergencyExit, IdleChalkboard, ProjectorControl, useClassroomDate, useProjectionCurtain } from "./ClassroomScene";
import { ActivityInput, ClassroomSettings, DeviceCard } from './ClassroomDevices';
import { fixedClassroomSeats, memberDevices } from './classroom-members';
import { useClassroomProfile } from './use-classroom-profile';
import { requestScreenShare } from './screen-share';
import { type PublicTaskPreview } from "./classroom-view";
import { useClassroomBoards } from "./use-classroom-boards";
import { adjacentBoardId, orderClassroomBoards } from "./classroom-boards";
import { ClassroomTodoCard, useClassroomTodoClock } from "./ClassroomTodo";
import { classroomTodoTasks, classroomTodoWindow, mergeTodoSnapshot } from "./classroom-todo";

type Task = {
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

type ChatQuote = { id: string; sender: string; body: string };
type ChatAttachment = { id: string; url: string; name: string; size: number; mimeType: string; kind: "image" | "file" | "audio" };
type ChatMessage = { id: string; body: string; imageUrl?: string; attachment?: ChatAttachment; replyTo?: ChatQuote; identityId?: string; time: string; createdAt?: number; sender: string; own?: boolean; delivery?: "sending" | "failed"; error?: string };
type OutgoingChat = { message: ChatMessage; file?: File; attachment?: ChatAttachment };
type SharedTask = Pick<Task, "id" | "title" | "project" | "startDate" | "dueDate" | "done" | "isAllDay" | "completedDay">;
type MediaItem = {
  id: string;
  label: string;
  stream: MediaStream;
  kind: MediaSource;
  remote: boolean;
};

const USE_LIVEKIT = false;
const MAX_REMOTE_DEVICES = 7;
const chatImageUrlPattern = /^\/api\/chat\/(?:images|files)\/[0-9a-f-]{36}$/i;

const MOBILE_BACKGROUND_GRACE_MS = 30 * 60 * 1000;

const isMobileBrowser = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const normalizeChatAttachment = (value: unknown): ChatAttachment | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<ChatAttachment>;
  if (typeof item.id !== "string" || typeof item.url !== "string" || item.url !== `/api/chat/files/${item.id}`
    || typeof item.name !== "string" || typeof item.size !== "number" || typeof item.mimeType !== "string"
    || (item.kind !== "image" && item.kind !== "file" && item.kind !== "audio")) return undefined;
  return { id: item.id, url: item.url, name: item.name, size: item.size, mimeType: item.mimeType, kind: item.kind };
};

const validChatContent = (body: unknown, imageUrl: unknown, attachment?: unknown) => (
  (typeof body === "string" && body.trim().length > 0)
  || (typeof imageUrl === "string" && chatImageUrlPattern.test(imageUrl))
  || Boolean(normalizeChatAttachment(attachment))
);

const formatFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
};

const beijingTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const formatChatTime = (message: ChatMessage) => (
  typeof message.createdAt === "number" && Number.isFinite(message.createdAt)
    ? beijingTimeFormatter.format(new Date(message.createdAt))
    : message.time
);

const normalizeChatQuote = (value: unknown): ChatQuote | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const quote = value as Partial<ChatQuote>;
  if (typeof quote.id !== "string" || typeof quote.sender !== "string" || typeof quote.body !== "string") return undefined;
  return { id: quote.id.slice(0, 80), sender: quote.sender.trim().slice(0, 24) || "成员", body: quote.body.trim().slice(0, 160) };
};

const normalizeIncomingMessage = (value: unknown, currentIdentityId: string): ChatMessage | null => {
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

const mergeChatMessages = (incoming: ChatMessage[], current: ChatMessage[]) => {
  const byId = new Map<string, ChatMessage>();
  [...current, ...incoming].forEach((message) => byId.set(message.id, message));
  return [...byId.values()].sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0) || left.id.localeCompare(right.id));
};


function MediaVideo({ stream, label, className, muted = true, onAudioBlocked }: { stream: MediaStream; label: string; className: string; muted?: boolean; onAudioBlocked?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    video.muted = muted;
    video.volume = 1;
    let disposed = false;
    const play = async () => {
      try { await video.play(); }
      catch (error) {
        if (disposed || video.srcObject !== stream) return;
        if ((error as DOMException).name === "NotAllowedError" && !video.muted) {
          // Autoplay restrictions must not prevent the video frames from appearing.
          video.muted = true;
          if (!muted) onAudioBlocked?.();
          await video.play().catch(() => undefined);
        }
      }
    };
    let hiddenAt = 0;
    const resume = () => {
      if (document.visibilityState !== "visible") { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > 3000 && document.pictureInPictureElement !== video) {
        // A suspended decoder can remain black while paused is false. Reattach it.
        video.pause();
        video.srcObject = null;
        video.srcObject = stream;
      }
      hiddenAt = 0;
      void play();
    };
    const onReady = () => { if (video.paused) void play(); };
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("canplay", onReady);
    document.addEventListener("visibilitychange", resume);
    void play();
    return () => {
      disposed = true;
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("canplay", onReady);
      document.removeEventListener("visibilitychange", resume);
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [muted, onAudioBlocked, stream]);

  return <video className={className} ref={ref} autoPlay muted={muted} playsInline disablePictureInPicture={false} aria-label={label} />;
}

export default function Home() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const classroomDate = useClassroomDate();
  const todoNow = useClassroomTodoClock();
  const today = todoNow ? classroomTodoWindow(todoNow).day : "";
  const [publicTasks, setPublicTasks] = useState<PublicTaskPreview[]>([]);
  const shareStartingRef = useRef(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [shareStarting, setShareStarting] = useState(false);
  const [remoteScreenMuted, setRemoteScreenMuted] = useState(false);
  const [remoteAudioBlocked, setRemoteAudioBlocked] = useState(false);
  const [pictureInPicture, setPictureInPicture] = useState(false);
  const [shareError, setShareError] = useState("");
  const [microphoneStream, setMicrophoneStream] = useState<MediaStream | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const microphoneBusy = useRef(false);
  const microphoneRequest = useRef(0);
  const [remoteMicrophones, setRemoteMicrophones] = useState<Record<string, MediaStream>>({});
  const [microphoneError, setMicrophoneError] = useState('');
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState("");
  const [roomMembers, setRoomMembers] = useState<string[]>([]);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [displayName, setDisplayName] = useState("");
  const [identityId, setIdentityId] = useState("");
  const [joined, setJoined] = useState(false);
  const [profileReady, setProfileReady] = useState(false);
  const [joinError, setJoinError] = useState("");
  const [remoteCameras, setRemoteCameras] = useState<Record<string, MediaStream>>({});
  const [remoteScreens, setRemoteScreens] = useState<Record<string, MediaStream>>({});
  const [activeMediaId, setActiveMediaId] = useState("");
  const [, setRoomStatus] = useState<"connecting" | "ready" | "error">("connecting");
  const [roomError, setRoomError] = useState("");
  const [syncOpen, setSyncOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [syncing, setSyncing] = useState(true);
  const [syncError, setSyncError] = useState("");
  const [token, setToken] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [chatImage, setChatImage] = useState<File | null>(null);
  const [chatImagePreview, setChatImagePreview] = useState("");
  const [viewedChatImage, setViewedChatImage] = useState<ViewedChatImage | null>(null);
  const [chatImageError, setChatImageError] = useState("");
  const [, setChatSending] = useState(false);
  const [chatUploadProgress, setChatUploadProgress] = useState<number | null>(null);
  const [chatHistoryLoading, setChatHistoryLoading] = useState(false);
  const [chatHistoryCursor, setChatHistoryCursor] = useState<string | null>(null);
  const [chatHistoryReady, setChatHistoryReady] = useState(false);
  const [chatQuote, setChatQuote] = useState<ChatQuote | null>(null);
  const [messageMenuId, setMessageMenuId] = useState("");
  const [messageMenuPlacement, setMessageMenuPlacement] = useState<"above" | "below">("below");
  const [sideView, setSideView] = useState<"chat" | "tasks">("chat");
  const { stageRef, fullscreen, fullscreenError, toggleFullscreen } = useMainFullscreen();
  const [bellHost, setBellHost] = useState<HTMLDivElement | null>(null);
  const showBellChat = useCallback(() => setSideView("chat"), []);
  const [memberTasks, setMemberTasks] = useState<Record<string, SharedTask[]>>({});
  const [activity, setActivity] = useState("");
  const [activitySaveStatus, setActivitySaveStatus] = useState("");
  const activitySavingRef = useRef(false);
  const [memberActivities, setMemberActivities] = useState<Record<string, string>>({});
  const [peerIdentityIds, setPeerIdentityIds] = useState<Record<string, string>>({});
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushTesting, setPushTesting] = useState(false);
  const [pushTestMessage, setPushTestMessage] = useState("");
  const [pushMessage, setPushMessage] = useState("");
  const [cloudOpen, setCloudOpen] = useState(false);
  const [, setCloudStatus] = useState<CloudStatus | null>(null);
  const [chatCloudUploads, setChatCloudUploads] = useState<Record<string, CloudSaveState>>({});
  const { boards, setBoards, activeBoardId, setActiveBoardId, createAndSelect } = useClassroomBoards();
  const [boardNotice, setBoardNotice] = useState("");
  const roomRef = useRef<Room | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<PeerClient | null>(null);
  const selfPeerIdRef = useRef("");
  const hostPeerIdRef = useRef("");
  const dataConnectionsRef = useRef(new Map<string, DataConnection>());
  const tasksRef = useRef<Task[]>([]);
  const activityRef = useRef("");
  const outgoingCallsRef = useRef(new Map<string, MediaConnection>());
  const incomingCallsRef = useRef(new Map<string, MediaConnection>());
  const callPeerRef = useRef<(peerId: string, media: MediaStream, source: MediaSource) => void>(() => undefined);
  const recoverPublishedMediaRef = useRef<(source: MediaSource) => void>(() => undefined);
  const displayNameRef = useRef("");
  const identityIdRef = useRef("");
  const memberNamesRef = useRef<Record<string, string>>({});
  const chatImageInputRef = useRef<HTMLInputElement>(null);
  const boardsRef = useRef<RoomBoard[]>([]);
  const packetReceiverRef = useRef(createPacketReceiver());
  const deletedBoardIdsRef = useRef(new Set<string>());
  const messageListRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressOriginRef = useRef({ x: 0, y: 0 });
  const longPressTriggeredRef = useRef(false);
  const chatAtBottomRef = useRef(true);
  const chatSavedScrollTopRef = useRef(0);
  const chatImageViewerOpenRef = useRef(false);
  const pendingHistoryScrollRef = useRef<{ height: number; top: number } | null>(null);
  const notificationAudioContextRef = useRef<AudioContext | null>(null);
  const pushDeviceIdRef = useRef("");
  const intentionalLeaveRef = useRef(false);
  const notifiedMessageIdsRef = useRef(new Set<string>());
  const chatSyncCursorRef = useRef(0);
  const chatSyncRequestRef = useRef(createChatSyncRequest());
  const outgoingChatRef = useRef(new Map<string, OutgoingChat>());
  const sendingChatIdsRef = useRef(new Set<string>());

  const markRemoteAudioBlocked = useCallback(() => setRemoteAudioBlocked(true), []);

  const broadcastRoomMessage = useCallback((message: object) => {
    try {
      for (const packet of encodeRoomPackets(message)) {
        void roomRef.current?.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(packet)), { reliable: true }).catch(() => undefined);
        dataConnectionsRef.current.forEach((connection) => {
          try { if (connection.open) connection.send(packet); } catch { /* Reconcile after reconnect. */ }
        });
      }
    } catch { setRoomError("画板同步数据过大，请保存后新建画板。"); }
  }, []);

  const classroomProfile = useClassroomProfile(joined, broadcastRoomMessage);

  const updateBoards = useCallback((update: (current: RoomBoard[]) => RoomBoard[]) => {
    const next = update(boardsRef.current).filter(board => !deletedBoardIdsRef.current.has(board.id));
    boardsRef.current = next;
    setBoards(next);
  }, [setBoards]);

  const refreshDeletedBoards = useCallback(async () => {
    const response = await fetch('/api/room/boards', { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('画板暂时无法读取，请重试。');
    const data = await response.json() as { deletedBoardIds: string[] };
    data.deletedBoardIds.forEach(id => deletedBoardIdsRef.current.add(id));
    updateBoards(current => current);
  }, [updateBoards]);

  useEffect(() => {
    if (!joined) return;
    const refresh = () => { if (!document.hidden) void refreshDeletedBoards().catch(() => undefined); };
    const timer = window.setInterval(refresh, 10_000);
    window.addEventListener('online', refresh); window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('online', refresh); window.removeEventListener('focus', refresh); };
  }, [joined, refreshDeletedBoards]);

  const receiveBoardMessage = useCallback(function receiveBoardMessage(message: { type?: string; boards?: unknown; deletedBoardIds?: unknown; board?: unknown; id?: unknown; boardId?: unknown; stroke?: unknown; strokeId?: unknown; text?: unknown; textId?: unknown; epoch?: unknown }) {
    if (message.type === "board-chunk") {
      const assembled = packetReceiverRef.current(message);
      if (assembled) receiveBoardMessage(assembled);
      return true;
    }
    if (message.type === "board-snapshot" && Array.isArray(message.boards)) {
      if (Array.isArray(message.deletedBoardIds)) message.deletedBoardIds.forEach((id) => { if (typeof id === "string") deletedBoardIdsRef.current.add(id); });
      const incoming = message.boards.flatMap((item) => {
        const board = normalizeBoard(item);
        return board ? [board] : [];
      }).slice(0, 12);
      updateBoards((current) => {
        const merged = new Map(current.filter((board) => !deletedBoardIdsRef.current.has(board.id)).map((board) => [board.id, board]));
        incoming.forEach((board) => {
          if (deletedBoardIdsRef.current.has(board.id)) return;
          const existing = merged.get(board.id);
          merged.set(board.id, existing ? mergeBoard(existing, board) : board);
        });
        const next = [...merged.values()].sort((left, right) => left.createdAt - right.createdAt).slice(0, 12);
        return next;
      });
      return true;
    }
    if (message.type === "board-create" || message.type === "board-upsert") {
      const board = normalizeBoard(message.board);
      if (!board || deletedBoardIdsRef.current.has(board.id)) return true;
      updateBoards((current) => {
        const next = current.some((item) => item.id === board.id)
          ? current.map((item) => item.id === board.id ? mergeBoard(item, board) : item)
          : [...current, board].slice(0, 12);
        return next;
      });
      return true;
    }
    if (typeof message.boardId === "string" && typeof message.epoch === "string") {
      if (message.type === "board-clear") {
        updateBoards((current) => {
          const next = current.map((board) => board.id === message.boardId && message.epoch! > board.epoch
            ? { ...board, epoch: message.epoch as string, strokes: [], texts: [], deletedStrokeIds: [], deletedTextIds: [] }
            : board);
          return next;
        });
        return true;
      }
      if (message.type === "board-stroke-add") {
        const stroke = normalizeBoardStroke(message.stroke);
        if (!stroke) return true;
        updateBoards((current) => {
          const next = current.map((board) => {
            if (board.id !== message.boardId || board.epoch !== message.epoch || board.deletedStrokeIds.includes(stroke.id)) return board;
            const previous = board.strokes.find((item) => item.id === stroke.id);
            if (previous && previous.revision >= stroke.revision) return board;
            return { ...board, strokes: sortBoardStrokes(previous ? board.strokes.map((item) => item.id === stroke.id ? stroke : item) : [...board.strokes, stroke]) };
          });
          return next;
        });
        return true;
      }
      if (message.type === "board-stroke-delete" && typeof message.strokeId === "string") {
        updateBoards((current) => {
          const next = current.map((board) => board.id === message.boardId && board.epoch === message.epoch
            ? { ...board, strokes: board.strokes.filter((stroke) => stroke.id !== message.strokeId), deletedStrokeIds: [...new Set([...board.deletedStrokeIds, message.strokeId as string])] }
            : board);
          return next;
        });
        return true;
      }
      if (message.type === "board-text-upsert") {
        const text = normalizeBoardText(message.text);
        if (!text) return true;
        updateBoards((current) => {
          const next = current.map((board) => {
            if (board.id !== message.boardId || board.epoch !== message.epoch || board.deletedTextIds.includes(text.id)) return board;
            const previous = board.texts.find((item) => item.id === text.id);
            if (previous && previous.revision >= text.revision) return board;
            return { ...board, texts: previous ? board.texts.map((item) => item.id === text.id ? text : item) : [...board.texts, text].slice(-200) };
          });
          return next;
        });
        return true;
      }
      if (message.type === "board-text-delete" && typeof message.textId === "string") {
        updateBoards((current) => {
          const next = current.map((board) => board.id === message.boardId && board.epoch === message.epoch
            ? { ...board, texts: board.texts.filter((text) => text.id !== message.textId), deletedTextIds: [...new Set([...board.deletedTextIds, message.textId as string])] }
            : board);
          return next;
        });
        return true;
      }
    }
    if (message.type === "board-delete" && typeof message.id === "string") {
      deletedBoardIdsRef.current.add(message.id);
      updateBoards((current) => {
        const next = current.filter((item) => item.id !== message.id);
        return next;
      });
      return true;
    }
    return false;
  }, [updateBoards]);

  useEffect(() => {
    if (!joined) return;
    const reconcile = () => {
      if (document.visibilityState === "visible" && (boardsRef.current.length || deletedBoardIdsRef.current.size)) broadcastRoomMessage({ type: "board-snapshot", boards: boardsRef.current, deletedBoardIds: [...deletedBoardIdsRef.current] });
    };
    const timer = window.setInterval(reconcile, 10_000);
    window.addEventListener("online", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => { window.clearInterval(timer); window.removeEventListener("online", reconcile); document.removeEventListener("visibilitychange", reconcile); };
  }, [joined, broadcastRoomMessage]);

  const playNotificationSound = useCallback((messageId: string) => {
    if (notifiedMessageIdsRef.current.has(messageId)) return;
    if (notifiedMessageIdsRef.current.size > 500) notifiedMessageIdsRef.current.clear();
    notifiedMessageIdsRef.current.add(messageId);
    try {
      const context = notificationAudioContextRef.current || new window.AudioContext();
      notificationAudioContextRef.current = context;
      void context.resume().then(() => {
        const start = context.currentTime;
        const gain = context.createGain();
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.12, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.34);
        gain.connect(context.destination);
        [659.25, 880].forEach((frequency, index) => {
          const oscillator = context.createOscillator();
          oscillator.type = "sine";
          oscillator.frequency.setValueAtTime(frequency, start + index * 0.08);
          oscillator.connect(gain);
          oscillator.start(start + index * 0.08);
          oscillator.stop(start + 0.34);
        });
      }).catch(() => undefined);
    } catch { /* Audio may be unavailable until the browser allows playback. */ }
  }, []);

  useEffect(() => {
    const unlockAudio = () => {
      try {
        const context = notificationAudioContextRef.current || new window.AudioContext();
        notificationAudioContextRef.current = context;
        if (context.state === "suspended") void context.resume();
      } catch { /* Web Audio is optional. */ }
    };
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    window.addEventListener("keydown", unlockAudio, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
      void notificationAudioContextRef.current?.close();
      notificationAudioContextRef.current = null;
    };
  }, []);

  useEffect(() => () => {
    if (chatImagePreview) URL.revokeObjectURL(chatImagePreview);
  }, [chatImagePreview]);

  useEffect(() => () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !identityId || pushBusy) return;
    let disposed = false;
    const requests = createChatSyncRequest();
    const initializePush = async () => {
      if (document.visibilityState !== "visible") { requests.cancel(); return; }
      if (disposed) return;
      const request = requests.begin();
      if (!request) return;
      try {
        pushDeviceIdRef.current = window.localStorage.getItem("11scat-push-device-id") || crypto.randomUUID();
        window.localStorage.setItem("11scat-push-device-id", pushDeviceIdRef.current);
        const registration = await navigator.serviceWorker.register("/sw.js");
        const subscription = await registration.pushManager.getSubscription();
        if (disposed || !request.isCurrent()) return;
        if (!subscription) {
          setPushEnabled(false);
          return;
        }
        const keyResponse = await fetch("/api/push/public-key", { cache: "no-store", signal: request.signal });
        const keyData = await keyResponse.json();
        if (!keyResponse.ok || !keyData.publicKey) throw new Error("推送配置不可用");
        if (subscriptionNeedsRenewal(subscription, keyData.publicKey)) {
          if (!disposed && request.isCurrent()) { setPushEnabled(false); setPushMessage("订阅已失效，请重新开启提醒。"); }
          return;
        }
        // Refresh the authenticated server record, not just the local browser flag.
        const response = await fetch("/api/push/subscriptions", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: subscription.toJSON(), deviceId: pushDeviceIdRef.current }),
          signal: request.signal,
        });
        if (!response.ok || response.redirected) throw new Error("订阅同步失败");
        if (!disposed && request.isCurrent()) { setPushEnabled(true); setPushMessage(""); }
      } catch {
        if (!disposed && request.isLatest()) { setPushEnabled(false); setPushMessage("暂时无法确认后台提醒状态，请检查网络后重新开启提醒。"); }
      } finally { request.finish(); }
    };
    void initializePush();
    document.addEventListener("visibilitychange", initializePush);
    window.addEventListener("online", initializePush);
    window.addEventListener("pageshow", initializePush);
    return () => {
      disposed = true; requests.cancel();
      document.removeEventListener("visibilitychange", initializePush);
      window.removeEventListener("online", initializePush);
      window.removeEventListener("pageshow", initializePush);
    };
  }, [identityId, pushBusy]);

  const enablePushNotifications = async () => {
    setPushBusy(true);
    setPushTestMessage("");
    setPushMessage("");
    try {
      const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
      const isStandalone = window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
      if (isIos && !isStandalone) throw new Error("iPhone 的 Safari 和 Edge 普通标签页都不能开启网页通知。请点“分享”→“添加到主屏幕”，关闭当前页面，再从手机桌面的 11scat 图标打开并开启提醒。");
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) throw new Error("当前浏览器或系统版本不支持网页消息提醒");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("需要允许通知，iPhone 和 Apple Watch 才能收到提醒");
      const keyResponse = await fetch("/api/push/public-key", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      const keyData = await keyResponse.json().catch(() => ({})) as { publicKey?: string; error?: string };
      if (!keyResponse.ok || !keyData.publicKey) throw new Error(keyData.error || "推送服务尚未配置");
      await navigator.serviceWorker.register("/sw.js");
      const registration = await navigator.serviceWorker.ready;
      let existing = await registration.pushManager.getSubscription();
      if (existing && subscriptionNeedsRenewal(existing, keyData.publicKey)) {
        if (!await existing.unsubscribe()) throw new Error("旧订阅移除失败，请重试。");
        existing = null;
      }
      const subscription = existing || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeVapidKey(keyData.publicKey) });
      if (!pushDeviceIdRef.current) {
        pushDeviceIdRef.current = window.localStorage.getItem("11scat-push-device-id") || crypto.randomUUID();
        window.localStorage.setItem("11scat-push-device-id", pushDeviceIdRef.current);
      }
      const response = await fetch("/api/push/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON(), deviceId: pushDeviceIdRef.current }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok || response.redirected) throw new Error("通知订阅保存失败，请检查登录状态后重试");
      setPushEnabled(true);
      setPushMessage("提醒已开启。");
    } catch (error) {
      setPushMessage(error instanceof Error ? error.message : "开启消息提醒失败");
    } finally {
      setPushBusy(false);
    }
  };

  const disablePushNotifications = async () => {
    setPushBusy(true);
    setPushTestMessage("");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const response = await fetch("/api/push/subscriptions", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }), signal: AbortSignal.timeout(10_000) });
        if (!response.ok || response.redirected) throw new Error("取消订阅失败");
        if (!await subscription.unsubscribe()) throw new Error("设备取消订阅失败");
      }
      setPushEnabled(false);
      setPushMessage("此设备的消息提醒已关闭。");
    } catch {
      setPushMessage("关闭失败，请在系统通知设置中关闭 11scat。");
    } finally {
      setPushBusy(false);
    }
  };

  const testPushNotifications = async () => {
    setPushTesting(true);
    setPushTestMessage("");
    try {
      if (!("Notification" in window) || Notification.permission !== "granted") throw new Error("此浏览器尚未允许通知，请在地址栏的网站设置中允许通知后重新开启提醒。");
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (!subscription) throw new Error("此设备没有有效订阅，请重新开启提醒。");
      const response = await fetch("/api/push/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }), signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json().catch(() => ({})) as { accepted?: boolean; error?: string };
      if (!response.ok || !data.accepted) throw new Error(data.error || "测试未成功，请检查登录状态后重试。");
      setPushTestMessage("推送服务已接受；设备显示待确认。");
    } catch (error) {
      setPushTestMessage(error instanceof Error ? error.message : "测试提醒失败");
    } finally { setPushTesting(false); }
  };

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
  }, [messages, sideView, scrollChatToBottom]);


  const taskLoadVersionRef = useRef(0);
  const loadTasks = useCallback(async () => {
    const version = ++taskLoadVersionRef.current;
    setSyncing(true);
    setSyncError("");
    try {
      const response = await fetch("/api/ticktick/tasks?view=today&classroom=1", { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (version !== taskLoadVersionRef.current) return false;
      if (response.status === 401) {
        setConnected(false);
        setTasks((current) => current.filter((task) => task.source === "local"));
        return false;
      }
      if (!response.ok) throw new Error("暂时无法读取滴答清单");
      const data = await response.json();
      if (version !== taskLoadVersionRef.current) return false;
      if (!Array.isArray(data.tasks) || !Array.isArray(data.projects)) throw new Error("滴答返回的数据格式异常");
      const remoteTasks: Task[] = data.tasks.map((task: Task) => ({ ...task, source: "ticktick" }));
      setConnected(true);
      if (typeof data.inboxError === "string") setSyncError(data.inboxError);
      setTasks((current) => mergeTodoSnapshot(current, [...remoteTasks, ...current.filter((task) => task.source === "local")]));
      return true;
    } catch (error) {
      if (version !== taskLoadVersionRef.current) return false;
      setSyncError(error instanceof Error ? error.message : "同步失败");
      return false;
    } finally {
      if (version === taskLoadVersionRef.current) setSyncing(false);
    }
  }, []);

  const loadedDayRef = useRef("");
  useEffect(() => {
    if (!today) return;
    if (loadedDayRef.current && loadedDayRef.current !== today) void loadTasks();
    loadedDayRef.current = today;
  }, [today, loadTasks]);

  const syncLatestChatMessages = useCallback(async (restart = false) => {
    if (!identityIdRef.current) return;
    const request = chatSyncRequestRef.current.begin(restart);
    if (!request) return;
    try {
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
        if (incoming.length || recalledIds.size) {
          setMessages((current) => {
            const remaining = recalledIds.size ? current.filter((message) => !recalledIds.has(message.id)) : current;
            const existingIds = new Set(remaining.map((message) => message.id));
            incoming.forEach((message) => {
              if (!message.own && !existingIds.has(message.id)) playNotificationSound(message.id);
            });
            return mergeChatMessages(incoming, remaining);
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
  }, [playNotificationSound]);

  const loadOlderChatMessages = async () => {
    if (chatHistoryLoading || !chatHistoryCursor) return;
    setChatHistoryLoading(true);
    try {
      const response = await fetch(`/api/chat/messages?limit=30&before=${encodeURIComponent(chatHistoryCursor)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("无法加载更早消息");
      const data = await response.json() as { messages?: unknown; nextCursor?: unknown };
      const incoming = Array.isArray(data.messages)
        ? data.messages.map((item) => normalizeIncomingMessage(item, identityIdRef.current)).filter((item): item is ChatMessage => Boolean(item))
        : [];
      // Capture immediately before prepending, so messages received while the
      // request was pending cannot consume the history position adjustment.
      const list = messageListRef.current;
      if (list) pendingHistoryScrollRef.current = { height: list.scrollHeight, top: list.scrollTop };
      setMessages((current) => mergeChatMessages(incoming, current));
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
    const timer = window.setTimeout(() => { void loadTasks(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadTasks]);

  useEffect(() => {
    if (!joined || chatHistoryReady || !identityIdRef.current) return;
    let disposed = false;
    const loadInitialChat = async () => {
      setChatHistoryLoading(true);
      try {
        const response = await fetch("/api/chat/messages?limit=30", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error("无法加载聊天记录");
        const data = await response.json() as { messages?: unknown; nextCursor?: unknown };
        if (disposed) return;
        const incoming = Array.isArray(data.messages)
          ? data.messages.map((item) => normalizeIncomingMessage(item, identityIdRef.current)).filter((item): item is ChatMessage => Boolean(item))
          : [];
        chatSyncCursorRef.current = incoming.reduce((latest, message) => Math.max(latest, message.createdAt || 0), chatSyncCursorRef.current);
        setMessages((current) => mergeChatMessages(incoming, current));
        setChatHistoryCursor(typeof data.nextCursor === "string" ? data.nextCursor : null);
      } catch (error) {
        if (!disposed) setChatImageError(error instanceof Error ? error.message : "无法加载聊天记录");
      } finally {
        if (!disposed) { setChatHistoryLoading(false); setChatHistoryReady(true); }
      }
    };
    void loadInitialChat();
    return () => { disposed = true; };
  }, [joined, chatHistoryReady]);

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

  useEffect(() => {
    let disposed = false;
    const loadProfile = async () => {
      try {
        const profile = fetch("/api/identity/me", { cache: "no-store", signal: AbortSignal.timeout(20_000) }).then(async response => {
          if (!response.ok) throw new Error("profile unavailable");
          const data = await response.json() as { identityId?: unknown; nickname?: unknown; activity?: unknown };
          const nickname = typeof data.nickname === "string" ? data.nickname.trim().slice(0, 24) : "";
          const fullIdentityId = typeof data.identityId === "string" ? data.identityId.trim().slice(0, 64) : "";
          const identityName = fullIdentityId.slice(0, 24);
          if (!disposed) {
            identityIdRef.current = fullIdentityId;
            setIdentityId(fullIdentityId);
            activityRef.current = typeof data.activity === "string" ? data.activity.trim().slice(0, 80) : "";
            setActivity(activityRef.current);
            setDisplayName(nickname || identityName || "成员");
          }
        });
        await Promise.all([profile, prepareClassroomAssets(), refreshDeletedBoards()]);
        if (!disposed) setJoined(true);
      } catch (error) {
        if (!disposed) setJoinError(error instanceof Error && error.message !== 'profile unavailable' ? error.message : "暂时无法读取身份资料，请重试。");
      } finally {
        if (!disposed) setProfileReady(true);
      }
    };
    void loadProfile();
    return () => { disposed = true; };
  }, [refreshDeletedBoards]);

  useEffect(() => {
    const entered = () => setPictureInPicture(true);
    const left = () => setPictureInPicture(false);
    document.addEventListener("enterpictureinpicture", entered, true);
    document.addEventListener("leavepictureinpicture", left, true);
    return () => {
      document.removeEventListener("enterpictureinpicture", entered, true);
      document.removeEventListener("leavepictureinpicture", left, true);
    };
  }, []);


  useEffect(() => {
    tasksRef.current = tasks;
    const shared = tasks.slice(0, 200).map(({ id, title, project, startDate, dueDate, done, isAllDay, completedDay }) => ({ id, title, project, startDate, dueDate, done, isAllDay, completedDay }));
    void roomRef.current?.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ type: "task-snapshot", tasks: shared })),
      { reliable: true },
    );
    dataConnectionsRef.current.forEach((connection) => {
      if (connection.open) connection.send({ type: "task-snapshot", tasks: shared });
    });
  }, [tasks]);
  useEffect(() => { displayNameRef.current = displayName.trim(); }, [displayName]);
  useEffect(() => { memberNamesRef.current = memberNames; }, [memberNames]);
  useEffect(() => () => stream?.getTracks().forEach((track) => track.stop()), [stream]);
  useEffect(() => () => cameraStream?.getTracks().forEach((track) => track.stop()), [cameraStream]);

  useEffect(() => {
    if (!joined || !USE_LIVEKIT) return;
    let disposed = false;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;
    const refreshMembers = () => {
      const participants = Array.from(room.remoteParticipants.values()).filter((participant) => participant.name !== "11scat member");
      setRoomMembers(participants.map((participant) => participant.identity));
      setMemberNames(Object.fromEntries(participants.map((participant) => [participant.identity, participant.name?.trim() || participant.identity])));
      setPeerIdentityIds(Object.fromEntries(participants.flatMap(participant => {
        try { const value = JSON.parse(participant.metadata || '{}'); return typeof value.identityId === 'string' ? [[participant.identity, value.identityId]] : []; }
        catch { return []; }
      })));
    };
    const removeRemote = (identity: string, source: MediaSource) => {
      const setter = source === "microphone" ? setRemoteMicrophones : source === "camera" ? setRemoteCameras : setRemoteScreens;
      setter((current) => { const next = { ...current }; delete next[identity]; return next; });
    };
    room.on(RoomEvent.ParticipantConnected, () => {
      refreshMembers();
      void room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: "activity", activity: activityRef.current })), { reliable: true }).catch(() => undefined);
      broadcastRoomMessage({ type: "board-snapshot", boards: boardsRef.current, deletedBoardIds: [...deletedBoardIdsRef.current] });
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      removeRemote(participant.identity, "microphone");
      removeRemote(participant.identity, "camera");
      removeRemote(participant.identity, "screen");
      setMemberNames((current) => {
        const next = { ...current };
        delete next[participant.identity];
        return next;
      });
      setMemberTasks((current) => {
        if (!current[participant.identity]) return current;
        const next = { ...current };
        delete next[participant.identity];
        return next;
      });
      setMemberActivities((current) => {
        if (!(participant.identity in current)) return current;
        const next = { ...current };
        delete next[participant.identity];
        return next;
      });
      refreshMembers();
    });
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (publication.source === Track.Source.Microphone) {
        setRemoteMicrophones(current => ({...current,[participant.identity]:new MediaStream([track.mediaStreamTrack])})); return;
      }
      if (track.kind !== Track.Kind.Video) return;
      const source: MediaSource = publication.source === Track.Source.ScreenShare ? "screen" : "camera";
      const setter = source === "camera" ? setRemoteCameras : setRemoteScreens;
      setter((current) => ({ ...current, [participant.identity]: new MediaStream([track.mediaStreamTrack]) }));
      refreshMembers();
    });
    room.on(RoomEvent.TrackUnsubscribed, (_track, publication, participant) => {
      if (publication.source === Track.Source.Microphone) { removeRemote(participant.identity, "microphone"); return; }
      if (publication.kind !== Track.Kind.Video) return;
      removeRemote(participant.identity, publication.source === Track.Source.ScreenShare ? "screen" : "camera");
    });
    room.on(RoomEvent.DataReceived, (payload, participant) => {
      try {
        const message = JSON.parse(new TextDecoder().decode(payload)) as ChatMessage & { type?: string; tasks?: unknown; activity?: unknown; boards?: unknown; board?: unknown };
        if (message.type === 'classroom-settings-changed') { window.dispatchEvent(new Event('classroom-settings-changed')); return; }
        if (receiveBoardMessage(message)) return;
        if (message.type === "chat-recall" && typeof message.id === "string") {
          setMessages((current) => current.filter((item) => item.id !== message.id));
          return;
        }
        if (message.type === "activity" && participant && typeof message.activity === "string") {
          const nextActivity = message.activity.trim().slice(0, 80);
          setMemberActivities((current) => ({ ...current, [participant.identity]: nextActivity }));
          return;
        }
        if (message.type === "task-snapshot" && participant && Array.isArray(message.tasks)) {
          const incomingTasks = message.tasks.filter((item): item is SharedTask => Boolean(
            item && typeof item === "object" && typeof (item as SharedTask).id === "string" && typeof (item as SharedTask).title === "string",
          ));
          setMemberTasks((current) => ({ ...current, [participant.identity]: incomingTasks.slice(0, 200) }));
          return;
        }
        if (message.type !== "chat") return;
        const normalized = normalizeIncomingMessage(message, identityIdRef.current);
        if (!normalized) return;
        const incomingMessage: ChatMessage = { ...normalized, sender: participant?.name?.trim() || normalized.sender || participant?.identity || "成员" };
        playNotificationSound(incomingMessage.id);
        setMessages((current) => current.some((item) => item.id === incomingMessage.id) ? current : [...current, incomingMessage]);
      } catch { /* ignore invalid room messages */ }
    });
    room.on(RoomEvent.Disconnected, () => {
      if (!disposed) { setRoomStatus("error"); setRoomError("实时房间连接已断开，请刷新后重试。"); }
    });
    const connect = async () => {
      try {
        const identityKey = "11scat-livekit-device-identity";
        let deviceIdentity = window.localStorage.getItem(identityKey);
        if (!deviceIdentity) {
          deviceIdentity = crypto.randomUUID();
          window.localStorage.setItem(identityKey, deviceIdentity);
        }
        const response = await fetch(`/api/livekit-token?name=${encodeURIComponent(displayName)}&identity=${encodeURIComponent(deviceIdentity)}`, { cache: "no-store" });
        if (!response.ok) throw new Error("LiveKit token unavailable");
        const { token, url } = await response.json() as { token: string; url: string };
        await room.connect(url, token);
        if (disposed) return;
        void room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: "activity", activity: activityRef.current })), { reliable: true }).catch(() => undefined);
        setRoomStatus("ready");
        setRoomError("");
        refreshMembers();
      } catch {
        if (!disposed) { setRoomStatus("error"); setRoomError("实时服务尚未完成配置，请稍后刷新重试。"); }
      }
    };
    void connect();
    return () => { disposed = true; room.disconnect(); roomRef.current = null; };
  }, [displayName, joined, playNotificationSound, receiveBoardMessage, broadcastRoomMessage]);

  useEffect(() => {
    if (!joined || USE_LIVEKIT) return;
    let disposed = false;
    let localPeer: PeerClient | null = null;
    const connections = dataConnectionsRef.current;
    const outgoingCalls = outgoingCallsRef.current;
    const incomingCalls = incomingCallsRef.current;
    const peerDeviceIds = new Map<string, string>();
    const mobilePeerIds = new Set<string>();
    const peerRemovalTimers = new Map<string, number>();
    const pendingPeerIds = new Set<string>();
    const mediaProgress = new Map<MediaConnection, { frames: number; changedAt: number; checking: boolean }>();
    const mediaRecovery = createMediaRecovery({
      peers: () => Array.from(connections.keys()),
      canSend: (peerId) => !disposed && Boolean(localPeer?.open && connections.get(peerId)?.open),
      stream: (source) => source === "microphone" ? microphoneStreamRef.current : source === "screen" ? screenStreamRef.current : cameraStreamRef.current,
      restart: (peerId, media, source) => {
        const key = `${source}:${peerId}`;
        const old = outgoingCalls.get(key);
        outgoingCalls.delete(key);
        old?.close();
        callPeer(peerId, media, source);
      },
    });
    recoverPublishedMediaRef.current = (source) => mediaRecovery.request(source);
    const connectionTimers = new Set<number>();
    let reconnectStartedAt = 0;
    let localDeviceId = "";
    let reconnectTimer: number | null = null;
    let recoveryMessageTimer: number | null = null;
    let presenceTimer: number | null = null;
    let reconnectAttempts = 0;
    let initializingRoom = false;
    const mobileClient = isMobileBrowser();

    const clearReconnectTimer = () => {
      if (reconnectTimer === null) return;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };

    const clearRecoveryMessageTimer = () => {
      if (recoveryMessageTimer === null) return;
      window.clearTimeout(recoveryMessageTimer);
      recoveryMessageTimer = null;
    };

    const recoverRoomConnection = () => {
      if (disposed) return;
      if (!navigator.onLine) {
        setRoomStatus("connecting");
        setRoomError("网络已断开，恢复后会自动重新连接。");
        return;
      }
      const peer = localPeer;
      if (!peer || peer.destroyed) {
        void initializeRoom();
        return;
      }
      if (!peer.open) {
        if (!reconnectStartedAt) reconnectStartedAt = Date.now();
        if (Date.now() - reconnectStartedAt > 20_000) {
          peer.destroy();
          localPeer = null;
          reconnectStartedAt = 0;
          pendingPeerIds.clear();
          void initializeRoom();
          return;
        }
        try { if (peer.disconnected) peer.reconnect(); } catch {
          peer.destroy();
          if (localPeer === peer) localPeer = null;
          void initializeRoom();
        }
        return;
      }
      if (peer.open) {
        reconnectStartedAt = 0;
        clearRecoveryMessageTimer();
        reconnectAttempts = 0;
        setRoomStatus("ready");
        setRoomError("");
        const hostId = hostPeerIdRef.current;
        if (hostId && hostId !== peer.id && !connections.get(hostId)?.open) connectToPeer(hostId);
      }
    };

    const scheduleRoomRecovery = (delay = 700) => {
      if (disposed || reconnectTimer !== null) return;
      if (recoveryMessageTimer === null) {
        recoveryMessageTimer = window.setTimeout(() => {
          recoveryMessageTimer = null;
          if (disposed || localPeer?.open) return;
          setRoomStatus("connecting");
          setRoomError(navigator.onLine ? "房间连接正在自动恢复，请稍候。" : "网络已断开，恢复后会自动重新连接。");
        }, 10_000);
      }
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        recoverRoomConnection();
        if (!disposed && navigator.onLine && (!localPeer?.open || localPeer.disconnected)) {
          reconnectAttempts += 1;
          scheduleRoomRecovery(Math.min(700 * (2 ** reconnectAttempts), 10000));
        }
      }, delay);
    };

    const syncRoomPresence = async (background = document.visibilityState !== "visible") => {
      const peer = localPeer;
      if (disposed || !peer?.open || !peer.id || !localDeviceId) return;
      try {
        const response = await fetch("/api/room/presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ peerId: peer.id, deviceId: localDeviceId, name: displayNameRef.current, mobile: mobileClient, background }),
          cache: "no-store",
          keepalive: background,
          signal: AbortSignal.timeout(10_000),
        });
        if (disposed || localPeer !== peer) return;
        if (!response.ok) throw new Error("presence unavailable");
        const data = await response.json() as { participants?: unknown };
        if (!Array.isArray(data.participants)) return;
        const discovered = data.participants.filter((item): item is { peerId: string; deviceId: string; name: string; identityId: string } => Boolean(
          item && typeof item === "object"
          && typeof (item as { peerId?: unknown }).peerId === "string"
          && typeof (item as { deviceId?: unknown }).deviceId === "string"
          && typeof (item as { name?: unknown }).name === "string"
          && typeof (item as { identityId?: unknown }).identityId === "string",
        )).filter((item) => item.peerId !== peer.id && item.deviceId !== localDeviceId);
        discovered.forEach((item) => {
          const replacedPeerId = Array.from(peerDeviceIds.entries()).find(([candidate, deviceId]) => candidate !== item.peerId && deviceId === item.deviceId)?.[0];
          if (replacedPeerId) removePeer(replacedPeerId);
          peerDeviceIds.set(item.peerId, item.deviceId);
          rememberPeerName(item.peerId, item.name);
          rememberPeerIdentity(item.peerId, item.identityId);
        });
        const roomPeerIds = [peer.id, ...discovered.map((item) => item.peerId)].sort();
        hostPeerIdRef.current = roomPeerIds[0] || peer.id;
        discovered
          .map((item) => item.peerId)
          .sort()
          .forEach((peerId) => {
            if (peer.id.localeCompare(peerId) < 0) connectToPeer(peerId);
            else if (!connections.get(peerId)?.open && !pendingPeerIds.has(peerId)) {
              const timer = window.setTimeout(() => {
                connectionTimers.delete(timer);
                if (!disposed && localPeer === peer) connectToPeer(peerId);
              }, 2000);
              connectionTimers.add(timer);
            }
          });
      } catch {
        if (!disposed && document.visibilityState === "visible") scheduleRoomRecovery(1200);
      }
    };

    const startPresenceHeartbeat = () => {
      if (presenceTimer !== null) window.clearInterval(presenceTimer);
      void syncRoomPresence();
      presenceTimer = window.setInterval(() => {
        recoverRoomConnection();
        mediaRecovery.flush();
        connections.forEach((connection) => {
          const state = connection.peerConnection?.connectionState;
          if (state === "failed" || state === "closed") connection.close();
          else if (connection.open) {
            // Closed media calls no longer appear in incomingCalls/getStats.
            // Reconcile even those missing calls, without replacing pending offers.
            connection.send({ type: "media-request" });
            if (cameraStreamRef.current) callPeer(connection.peer, cameraStreamRef.current, "camera");
            if (screenStreamRef.current) callPeer(connection.peer, screenStreamRef.current, "screen");
            if (microphoneStreamRef.current) callPeer(connection.peer, microphoneStreamRef.current, "microphone");
          }
        });
        incomingCalls.forEach((call, key) => {
          const progress = mediaProgress.get(call) || { frames: -1, changedAt: Date.now(), checking: false };
          mediaProgress.set(call, progress);
          if (progress.checking || !call.peerConnection) return;
          progress.checking = true;
          void call.peerConnection.getStats().then((stats) => {
            if (disposed || incomingCalls.get(key) !== call) return;
            let frames = 0;
            stats.forEach((report) => {
              const kind = report.kind || report.mediaType;
              if (report.type !== 'inbound-rtp') return;
              if (key.startsWith('microphone:') && kind === 'audio') frames += report.packetsReceived || 0;
              else if (kind === 'video') frames += report.framesDecoded || 0;
            });
            if (frames > progress.frames) { progress.frames = frames; progress.changedAt = Date.now(); }
            const failed = ["failed", "closed"].includes(call.peerConnection.connectionState);
            if (failed || Date.now() - progress.changedAt > 20_000) {
              const connection = connections.get(call.peer);
              if (connection?.open) {
                progress.changedAt = Date.now();
                connection.send({ type: "media-request", repair: true, source: key.startsWith('microphone:') ? 'microphone' : key.startsWith("screen:") ? "screen" : "camera" });
              }
            }
          }).catch(() => undefined).finally(() => { progress.checking = false; });
        });
        void syncRoomPresence();
      }, 5000);
    };

    const leaveRoomPresence = () => {
      if (!localDeviceId) return;
      void fetch("/api/room/presence", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: localDeviceId }),
        keepalive: true,
      });
    };

    const rememberPeerName = (peerId: string, value: unknown) => {
      const name = typeof value === "string" ? value.trim().slice(0, 24) : "";
      if (!name) return;
      setMemberNames((current) => current[peerId] === name ? current : { ...current, [peerId]: name });
    };

    const rememberPeerIdentity = (peerId: string, value: unknown) => {
      const identityId = typeof value === "string" ? value.trim().slice(0, 64) : "";
      if (!identityId) return;
      setPeerIdentityIds((current) => current[peerId] === identityId ? current : { ...current, [peerId]: identityId });
    };

    const refreshMembers = () => {
      setRoomMembers(Array.from(connections.keys()));
    };

    const removeRemoteMedia = (peerId: string, source: MediaSource) => {
      const setter = source === "microphone" ? setRemoteMicrophones : source === "camera" ? setRemoteCameras : setRemoteScreens;
      setter((current) => {
        if (!current[peerId]) return current;
        const next = { ...current };
        delete next[peerId];
        return next;
      });
    };

    const closePeerCalls = (peerId: string) => {
      (["camera", "screen", "microphone"] as MediaSource[]).forEach((source) => {
        const key = `${source}:${peerId}`;
        outgoingCalls.get(key)?.close();
        incomingCalls.get(key)?.close();
        outgoingCalls.delete(key);
        incomingCalls.delete(key);
        removeRemoteMedia(peerId, source);
      });
    };

    const removePeer = (peerId: string) => {
      mediaRecovery.forget(peerId);
      const removalTimer = peerRemovalTimers.get(peerId);
      if (removalTimer !== undefined) window.clearTimeout(removalTimer);
      peerRemovalTimers.delete(peerId);
      connections.delete(peerId);
      peerDeviceIds.delete(peerId);
      mobilePeerIds.delete(peerId);
      pendingPeerIds.delete(peerId);
      closePeerCalls(peerId);
      setRoomStatus("ready");
      setRoomError("");
      window.setTimeout(() => {
        if (!disposed && localPeer?.open && connections.size === 0) {
          setRoomStatus("ready");
          setRoomError("");
        }
      }, 300);
      setMemberNames((current) => {
        if (!current[peerId]) return current;
        const next = { ...current };
        delete next[peerId];
        return next;
      });
      setPeerIdentityIds((current) => {
        if (!current[peerId]) return current;
        const next = { ...current };
        delete next[peerId];
        return next;
      });
      setMemberTasks((current) => {
        if (!current[peerId]) return current;
        const next = { ...current };
        delete next[peerId];
        return next;
      });
      setMemberActivities((current) => {
        if (!(peerId in current)) return current;
        const next = { ...current };
        delete next[peerId];
        return next;
      });
      refreshMembers();
    };

    const schedulePeerRemoval = (peerId: string) => {
      if (peerRemovalTimers.has(peerId)) return;
      peerRemovalTimers.set(peerId, window.setTimeout(() => {
        peerRemovalTimers.delete(peerId);
        if (!connections.get(peerId)?.open) removePeer(peerId);
      }, mobilePeerIds.has(peerId) ? MOBILE_BACKGROUND_GRACE_MS : 10_000));
    };

    const callPeer = (peerId: string, media: MediaStream, source: MediaSource, attempt = 0) => {
      if (!localPeer?.open || !connections.get(peerId)?.open) return;
      const key = `${source}:${peerId}`;
      const existing = outgoingCalls.get(key);
      if (!(source === "microphone" ? media.getAudioTracks() : media.getVideoTracks()).some((track) => track.readyState === "live")) return;
      if (mediaCallReusable(existing)) return;
      existing?.close();

      const call = localPeer.call(peerId, media, { metadata: { source, name: displayNameRef.current, identityId: identityIdRef.current } });
      outgoingCalls.set(key, call);
      const retry = () => {
        if (disposed || outgoingCalls.get(key) !== call) return;
        outgoingCalls.delete(key);
        call.close();
        const currentStream = source === "microphone" ? microphoneStreamRef.current : source === "camera" ? cameraStreamRef.current : screenStreamRef.current;
        if (!currentStream || currentStream !== media || attempt >= 3) return;
        window.setTimeout(() => callPeer(peerId, currentStream, source, attempt + 1), 900 * (attempt + 1));
      };
      window.setTimeout(() => {
        if (outgoingCalls.get(key) === call && !call.open) retry();
      }, 7000);
      call.on("close", () => {
        if (outgoingCalls.get(key) === call) outgoingCalls.delete(key);
      });
      call.on("error", retry);
    };

    callPeerRef.current = callPeer;

    const broadcastPeerList = () => {
      const selfId = selfPeerIdRef.current;
      if (!selfId || hostPeerIdRef.current !== selfId) return;
      const ids = [selfId, ...connections.keys()];
      connections.forEach((connection) => {
        if (connection.open) connection.send({ type: "peer-list", ids });
      });
    };

    function connectToPeer(peerId: string) {
      const selfId = selfPeerIdRef.current;
      const openConnections = Array.from(connections.values()).filter((item) => item.open).length;
      if (!localPeer?.open || !peerId || peerId === selfId || connections.get(peerId)?.open || pendingPeerIds.has(peerId) || openConnections >= MAX_REMOTE_DEVICES) return;
      pendingPeerIds.add(peerId);
      try {
        bindConnection(localPeer.connect(peerId, {
          reliable: true,
          metadata: { room: "11scat-global-room", name: displayNameRef.current, deviceId: localDeviceId, identityId: identityIdRef.current, mobile: mobileClient },
        }));
      } catch {
        pendingPeerIds.delete(peerId);
      }
    }

    function bindConnection(connection: DataConnection, incoming = false) {
      const peerId = connection.peer;
      const openTimer = window.setTimeout(() => {
        connectionTimers.delete(openTimer);
        if (disposed || connection.open) return;
        pendingPeerIds.delete(peerId);
        connection.close();
        void syncRoomPresence();
      }, 12_000);
      connectionTimers.add(openTimer);
      const clearOpenTimer = () => { window.clearTimeout(openTimer); connectionTimers.delete(openTimer); };

      const handleOpen = () => {
        clearOpenTimer();
        if (disposed) return;
        const graceTimer = peerRemovalTimers.get(peerId);
        if (graceTimer !== undefined) window.clearTimeout(graceTimer);
        peerRemovalTimers.delete(peerId);
        pendingPeerIds.delete(peerId);
        const incomingDeviceId = incoming && typeof connection.metadata?.deviceId === "string"
          ? connection.metadata.deviceId.trim().slice(0, 80)
          : "";
        if (incoming && connection.metadata?.mobile === true) mobilePeerIds.add(peerId);
        if (incomingDeviceId) {
          const replacedPeerId = Array.from(connections.keys()).find((candidate) => (
            candidate !== peerId && peerDeviceIds.get(candidate) === incomingDeviceId
          ));
          if (replacedPeerId) {
            const replacedConnection = connections.get(replacedPeerId);
            removePeer(replacedPeerId);
            replacedConnection?.close();
          }
        }
        const existing = connections.get(peerId);
        const openConnections = Array.from(connections.values()).filter((item) => item.open).length;
        if (!existing?.open && openConnections >= MAX_REMOTE_DEVICES) {
          connection.close();
          return;
        }
        if (existing && existing !== connection && existing.open) {
          connection.close();
          return;
        }

        connections.set(peerId, connection);
        if (incomingDeviceId) peerDeviceIds.set(peerId, incomingDeviceId);
        rememberPeerName(peerId, connection.metadata?.name);
        rememberPeerIdentity(peerId, connection.metadata?.identityId);
        setRoomError("");
        refreshMembers();
        connection.send({ type: "presence", name: displayNameRef.current, identityId: identityIdRef.current, deviceId: localDeviceId, activity: activityRef.current, mobile: mobileClient });
        connection.send({
          type: "task-snapshot",
          tasks: tasksRef.current.slice(0, 200).map(({ id, title, project, startDate, dueDate, done, isAllDay, completedDay }) => ({ id, title, project, startDate, dueDate, done, isAllDay, completedDay })),
        });
        connection.send({ type: "media-request" });
        encodeRoomPackets({ type: "board-snapshot", boards: boardsRef.current, deletedBoardIds: [...deletedBoardIdsRef.current] }).forEach((packet) => connection.send(packet));
        if (hostPeerIdRef.current === selfPeerIdRef.current) broadcastPeerList();
        if (cameraStreamRef.current) callPeer(peerId, cameraStreamRef.current, "camera");
        if (screenStreamRef.current) callPeer(peerId, screenStreamRef.current, "screen");
          if (microphoneStreamRef.current) callPeer(peerId, microphoneStreamRef.current, "microphone");
      };

      connection.on("open", handleOpen);
      connection.on("data", (payload) => {
        if (!payload || typeof payload !== "object" || !("type" in payload)) return;
        const message = payload as { type: string; ids?: unknown; tasks?: unknown; id?: unknown; body?: unknown; imageUrl?: unknown; attachment?: unknown; replyTo?: unknown; identityId?: unknown; time?: unknown; createdAt?: unknown; sender?: unknown; name?: unknown; deviceId?: unknown; activity?: unknown; mobile?: unknown; boards?: unknown; board?: unknown };
        if (message.type === 'classroom-settings-changed') { window.dispatchEvent(new Event('classroom-settings-changed')); return; }
        if (receiveBoardMessage(message)) return;
        if (message.type === "chat-recall" && typeof message.id === "string") {
          setMessages((current) => current.filter((item) => item.id !== message.id));
          return;
        }
        if (message.type === "presence") {
          rememberPeerName(peerId, message.name);
          rememberPeerIdentity(peerId, message.identityId);
          if (message.mobile === true) mobilePeerIds.add(peerId);
          if (typeof message.activity === "string") {
            const nextActivity = message.activity.trim().slice(0, 80);
            setMemberActivities((current) => ({ ...current, [peerId]: nextActivity }));
          }
          const deviceId = typeof message.deviceId === "string" ? message.deviceId.trim().slice(0, 80) : "";
          if (deviceId) peerDeviceIds.set(peerId, deviceId);
          return;
        }
        if (message.type === "activity" && typeof message.activity === "string") {
          const nextActivity = message.activity.trim().slice(0, 80);
          setMemberActivities((current) => ({ ...current, [peerId]: nextActivity }));
          return;
        }
        if (message.type === "media-request") {
          const request = payload as { repair?: boolean; source?: string };
          if (request.repair === true && (request.source === "screen" || request.source === "camera" || request.source === "microphone")) {
            mediaRecovery.request(request.source, peerId);
            return;
          }
          if (cameraStreamRef.current) callPeer(peerId, cameraStreamRef.current, "camera");
          if (screenStreamRef.current) callPeer(peerId, screenStreamRef.current, "screen");
          if (microphoneStreamRef.current) callPeer(peerId, microphoneStreamRef.current, "microphone");
          return;
        }
        if (message.type === "task-snapshot" && Array.isArray(message.tasks)) {
          const incomingTasks = message.tasks.filter((item): item is SharedTask => Boolean(
            item && typeof item === "object" && typeof (item as SharedTask).id === "string" && typeof (item as SharedTask).title === "string",
          ));
          setMemberTasks((current) => ({ ...current, [peerId]: incomingTasks.slice(0, 200) }));
          return;
        }
        if (message.type === "chat") {
          const normalized = normalizeIncomingMessage(message, identityIdRef.current);
          if (!normalized) return;
          const incomingMessage: ChatMessage = {
            ...normalized,
            sender: normalized.sender || memberNamesRef.current[peerId] || "成员",
          };
          playNotificationSound(incomingMessage.id);
          setMessages((current) => current.some((item) => item.id === incomingMessage.id) ? current : [...current, incomingMessage]);
          return;
        }
        if (message.type !== "peer-list" || !Array.isArray(message.ids)) return;

        const selfId = selfPeerIdRef.current;
        message.ids.forEach((candidate) => {
          if (typeof candidate !== "string" || candidate === selfId || connections.get(candidate)?.open) return;
          if (candidate === hostPeerIdRef.current || selfId.localeCompare(candidate) < 0) connectToPeer(candidate);
        });
      });
      connection.on("close", () => {
        clearOpenTimer();
        pendingPeerIds.delete(peerId);
        if (connections.get(peerId) !== connection) return;
        schedulePeerRemoval(peerId);
        if (!disposed) void syncRoomPresence();
        if (hostPeerIdRef.current === selfPeerIdRef.current) broadcastPeerList();
      });
      connection.on("error", () => {
        clearOpenTimer();
        pendingPeerIds.delete(peerId);
        if (connections.get(peerId) !== connection) return;
        connection.close();
        schedulePeerRemoval(peerId);
      });
      if (connection.open) handleOpen();
    }

    const initializeRoom = async () => {
      if (disposed || initializingRoom) return;
      initializingRoom = true;
      try {
        const { Peer } = await import("peerjs");
        if (disposed) return;

        try {
          const deviceKey = "11scat-peer-device-id";
          localDeviceId = window.localStorage.getItem(deviceKey) || crypto.randomUUID();
          window.localStorage.setItem(deviceKey, localDeviceId);
        } catch {
          localDeviceId = crypto.randomUUID();
        }

        let peerOptions: PeerOptions = { debug: 1 };
        try {
          const response = await fetch("/api/realtime-config", { cache: "no-store" });
          const data = await response.json() as {
            iceServers?: RTCIceServer[];
            peerServer?: { path?: string; key?: string } | null;
          };
          if (Array.isArray(data.iceServers) && data.iceServers.length) {
            peerOptions = { debug: 1, config: { iceServers: data.iceServers } };
          }
          if (data.peerServer?.path) {
            const secure = window.location.protocol === "https:";
            peerOptions = {
              ...peerOptions,
              host: window.location.hostname,
              port: window.location.port ? Number(window.location.port) : secure ? 443 : 80,
              path: data.peerServer.path,
              key: data.peerServer.key || "peerjs",
              secure,
            };
          }
        } catch { /* STUN defaults remain available when TURN config cannot be loaded. */ }

        const handleCall = (call: MediaConnection) => {
          const peerId = call.peer;
          const source: MediaSource = call.metadata?.source === "microphone" ? "microphone" : call.metadata?.source === "screen" ? "screen" : "camera";
          rememberPeerName(peerId, call.metadata?.name);
          rememberPeerIdentity(peerId, call.metadata?.identityId);
          const key = `${source}:${peerId}`;
          const previous = incomingCalls.get(key);
          incomingCalls.set(key, call);
          previous?.close();
          if (previous) mediaProgress.delete(previous);
          call.answer();
          call.on("stream", (remoteStream) => {
            if (disposed || incomingCalls.get(key) !== call) return;
            const setter = source === "microphone" ? setRemoteMicrophones : source === "camera" ? setRemoteCameras : setRemoteScreens;
            setter((current) => ({ ...current, [peerId]: remoteStream }));
            setRoomError("");
            if (source === "screen") setActiveMediaId(`${peerId}-screen`);
            remoteStream.getTracks()[0]?.addEventListener("ended", () => {
              if (incomingCalls.get(key) === call) removeRemoteMedia(peerId, source);
            });
          });
          call.on("close", () => {
            mediaProgress.delete(call);
            if (incomingCalls.get(key) !== call) return;
            incomingCalls.delete(key);
            removeRemoteMedia(peerId, source);
          });
          call.on("error", () => {
            mediaProgress.delete(call);
            if (incomingCalls.get(key) !== call) return;
            incomingCalls.delete(key);
            removeRemoteMedia(peerId, source);
          });
        };

        const attachPeer = (peer: PeerClient) => {
          localPeer = peer;
          peerRef.current = peer;
          peer.on("open", (id) => {
            if (disposed) return;
            clearReconnectTimer();
            clearRecoveryMessageTimer();
            reconnectAttempts = 0;
            selfPeerIdRef.current = id;
            hostPeerIdRef.current = id;
            if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
            setRoomStatus("ready");
            setRoomError("");
            startPresenceHeartbeat();
          });
          peer.on("connection", (connection) => bindConnection(connection, true));
          peer.on("call", handleCall);
          peer.on("disconnected", () => {
            if (!disposed && localPeer === peer) scheduleRoomRecovery();
          });
          peer.on("error", (error) => {
            if (error.type === "peer-unavailable") {
              void syncRoomPresence();
              return;
            }
            if (error.type === "webrtc") {
              setRoomError("画面连接正在重试，请稍候。");
              return;
            }
            if (["disconnected", "network", "server-error", "socket-error", "socket-closed"].includes(error.type)) {
              scheduleRoomRecovery();
              return;
            }
            setRoomStatus("error");
            setRoomError("实时房间连接失败，请检查代理网络后刷新页面。");
          });
        };

        attachPeer(new Peer(peerOptions));
      } catch {
        setRoomStatus("error");
        setRoomError("实时房间组件加载失败，请刷新页面重试。");
      } finally {
        initializingRoom = false;
      }
    };

    let hiddenSince = 0;
    let lastMediaResume = 0;
    const resumeMedia = () => {
      if (document.visibilityState !== "visible" || !hiddenSince) return;
      const duration = Date.now() - hiddenSince;
      hiddenSince = 0;
      if (duration < 3000 || Date.now() - lastMediaResume < 5000) return;
      lastMediaResume = Date.now();
      // This page is also a publisher. Remote requests alone repair the wrong
      // direction when our own screen sender was suspended in the background.
      mediaRecovery.request("screen");
      mediaRecovery.request("camera");
      mediaRecovery.request("microphone");
      // Re-request even when the old MediaConnection still reports open.
      connections.forEach((connection) => {
        if (!connection.open) return;
        connection.send({ type: "media-request", repair: true, source: "screen" });
        connection.send({ type: "media-request", repair: true, source: "camera" });
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        hiddenSince = Date.now();
        void syncRoomPresence(true);
        return;
      }
      clearReconnectTimer();
      recoverRoomConnection();
      void syncRoomPresence();
      resumeMedia();
    };
    const recoverWhenActive = () => {
      clearReconnectTimer();
      recoverRoomConnection();
      void syncRoomPresence();
      resumeMedia();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", recoverWhenActive);
    window.addEventListener("online", recoverWhenActive);
    window.addEventListener("pageshow", recoverWhenActive);
    void initializeRoom();

    return () => {
      disposed = true;
      clearReconnectTimer();
      clearRecoveryMessageTimer();
      if (presenceTimer !== null) window.clearInterval(presenceTimer);
      if (!mobileClient || intentionalLeaveRef.current) leaveRoomPresence();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", recoverWhenActive);
      window.removeEventListener("online", recoverWhenActive);
      window.removeEventListener("pageshow", recoverWhenActive);
      callPeerRef.current = () => undefined;
      recoverPublishedMediaRef.current = () => undefined;
      connections.forEach((connection) => connection.close());
      outgoingCalls.forEach((call) => call.close());
      incomingCalls.forEach((call) => call.close());
      connections.clear();
      outgoingCalls.clear();
      incomingCalls.clear();
      pendingPeerIds.clear();
      connectionTimers.forEach((timer) => window.clearTimeout(timer));
      connectionTimers.clear();
      peerRemovalTimers.forEach((timer) => window.clearTimeout(timer));
      peerRemovalTimers.clear();
      localPeer?.destroy();
      peerRef.current = null;
    };
  }, [joined, playNotificationSound, receiveBoardMessage]);

  useEffect(() => {
    cameraStreamRef.current = cameraStream;
    outgoingCallsRef.current.forEach((call, key) => {
      if (!key.startsWith("camera:")) return;
      call.close();
      outgoingCallsRef.current.delete(key);
    });
    if (cameraStream) {
      dataConnectionsRef.current.forEach((_connection, peerId) => callPeerRef.current(peerId, cameraStream, "camera"));
    }
  }, [cameraStream]);

  useEffect(() => {
    screenStreamRef.current = stream;
    outgoingCallsRef.current.forEach((call, key) => {
      if (!key.startsWith("screen:")) return;
      call.close();
      outgoingCallsRef.current.delete(key);
    });
    if (stream) {
      dataConnectionsRef.current.forEach((_connection, peerId) => callPeerRef.current(peerId, stream, "screen"));
    }
    const track = stream?.getVideoTracks()[0];
    const onUnmute = () => recoverPublishedMediaRef.current("screen");
    track?.addEventListener("unmute", onUnmute);
    return () => track?.removeEventListener("unmute", onUnmute);
  }, [stream]);

  const toggleTask = async (task: Task) => {
    if (task.done) return;
    const completedDay = classroomTodoWindow().day;
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, done: true, completedDay } : item));
    if (task.source === "ticktick" && task.projectId) {
      try {
        const response = await fetch("/api/ticktick/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: task.projectId, taskId: task.id }),
        });
        if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || "完成状态没有同步成功"); }
        if (response.status !== 204) {
          const result = await response.json().catch(() => null);
          if (result?.workflow && result.workflow.status !== 'done') throw new Error('请在任务板完成提交与确认');
        }
      } catch (error) {
        setTasks((current) => current.map((item) => item.id === task.id ? { ...item, done: false } : item));
        setSyncError(error instanceof Error ? error.message : "完成状态没有同步成功");
      }
    }
  };

  const connectTickTick = async (event: FormEvent) => {
    event.preventDefault();
    setSyncError("");
    const response = await fetch("/api/ticktick/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token.trim() }),
    });
    if (!response.ok) {
      setSyncError("Token 无效或滴答接口暂时不可用");
      return;
    }
    setToken("");
    const loaded = await loadTasks();
    if (loaded) setSyncOpen(false);
  };

  const disconnectTickTick = async () => {
    await fetch("/api/ticktick/token", { method: "DELETE" });
    setConnected(false);
    setTasks((current) => current.filter((task) => task.source === "local"));
    setSyncOpen(false);
  };

  const startShare = async () => {
    if (shareStartingRef.current || screenStreamRef.current) return;
    setShareError("");
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setShareError("当前浏览器不支持屏幕共享，请使用最新版 Chrome、Edge 或 Safari。");
      return;
    }
    shareStartingRef.current = true;
    setShareStarting(true);
    let captured: MediaStream | null = null;
    try {
      const nextStream = await requestScreenShare();
      captured = nextStream;
      const track = nextStream.getVideoTracks()[0];
      if (!track || track.readyState !== "live") throw new Error("No live screen track");
      track.addEventListener("ended", () => {
        nextStream.getTracks().forEach((item) => { void roomRef.current?.localParticipant.unpublishTrack(item); item.stop(); });
        if (screenStreamRef.current === nextStream) {
          screenStreamRef.current = null;
          setStream(null);
        }
      });
      if (roomRef.current) {
        await roomRef.current.localParticipant.publishTrack(track, { source: Track.Source.ScreenShare });
        const audioTrack = nextStream.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.contentHint = "music";
          await roomRef.current.localParticipant.publishTrack(audioTrack, { source: Track.Source.ScreenShareAudio });
        }
      }
      if (track.readyState !== 'live' || intentionalLeaveRef.current) throw new Error('Screen sharing ended');
      screenStreamRef.current = nextStream;
      setStream(nextStream);
      setActiveMediaId("self-screen");
      projection.reveal();
    } catch (error) {
      captured?.getTracks().forEach(track => { void roomRef.current?.localParticipant.unpublishTrack(track); track.stop(); });
      if ((error as DOMException).name !== "NotAllowedError") setShareError("没有成功开始共享，请重新选择窗口或屏幕。");
    } finally { shareStartingRef.current = false; setShareStarting(false); }
  };

  const stopShare = () => {
    const current = screenStreamRef.current || stream;
    current?.getTracks().forEach((track) => { void roomRef.current?.localParticipant.unpublishTrack(track); track.stop(); });
    screenStreamRef.current = null;
    setStream(null);
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
  };

  const toggleRemoteScreenAudio = () => {
    const video = document.querySelector<HTMLVideoElement>("video.main-media.screen.remote");
    const hasAudio = Boolean(video?.srcObject && (video.srcObject as MediaStream).getAudioTracks().some((track) => track.readyState === "live"));
    if (!video || !hasAudio) {
      setShareError("对方当前的共享没有音频。如需声音，请对方重新投屏，并在浏览器的共享窗口中选择共享音频。");
      return;
    }
    const enableAudio = remoteScreenMuted || remoteAudioBlocked;
    video.muted = !enableAudio;
    video.volume = 1;
    setRemoteScreenMuted(!enableAudio);
    setRemoteAudioBlocked(false);
    if (enableAudio) void video.play().catch(() => setShareError("浏览器仍阻止声音播放，请点击页面后再试一次。"));
  };

  const togglePictureInPicture = async () => {
    setShareError("");
    try {
      const video = document.querySelector<HTMLVideoElement>("video.main-media.screen");
      if (!video) throw new Error("请先选择一个共享画面");
      const safariVideo = video as HTMLVideoElement & {
        webkitSupportsPresentationMode?: (mode: string) => boolean;
        webkitSetPresentationMode?: (mode: string) => void;
        webkitPresentationMode?: string;
      };
      if (safariVideo.webkitPresentationMode === "picture-in-picture" && safariVideo.webkitSetPresentationMode) {
        safariVideo.webkitSetPresentationMode("inline");
        setPictureInPicture(false);
        return;
      }
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setPictureInPicture(false);
        return;
      }
      if (safariVideo.webkitSupportsPresentationMode?.("picture-in-picture") && safariVideo.webkitSetPresentationMode) {
        const syncSafariState = () => {
          const active = safariVideo.webkitPresentationMode === "picture-in-picture";
          setPictureInPicture(active);
          if (!active) video.removeEventListener("webkitpresentationmodechanged", syncSafariState);
        };
        video.addEventListener("webkitpresentationmodechanged", syncSafariState);
        void video.play().catch(() => undefined);
        safariVideo.webkitSetPresentationMode("picture-in-picture");
        setPictureInPicture(true);
        return;
      }
      await video.play();
      if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
        await video.requestPictureInPicture();
        setPictureInPicture(true);
        video.addEventListener("leavepictureinpicture", () => setPictureInPicture(false), { once: true });
        return;
      }
      throw new Error(isMobileBrowser() ? "请在 iPhone 设置 → 通用 → 画中画中开启“自动开启画中画”" : "当前浏览器不支持共享画面小窗");
    } catch (error) {
      setShareError(error instanceof Error ? error.message : "小窗开启失败，请重试");
    }
  };

  const openCloud = () => setCloudOpen(true);

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
      const statusResponse = await fetch("/api/cloud", { cache: "no-store" });
      const statusResult = await statusResponse.json().catch(() => null) as { status?: CloudStatus } | null;
      if (statusResult?.status) setCloudStatus(statusResult.status);
    } catch (error) {
      setChatCloudUploads((current) => ({ ...current, [attachment.id]: "failed" }));
      setChatImageError(error instanceof Error ? error.message : "上传到云盘失败");
    }
  };

  const createBoard = () => {
    if (boardsRef.current.length >= 12) { setBoardNotice("最多保留 12 张画板，可点击画板右上角删除不用的画板"); return; }
    projection.fold();
    const board: RoomBoard = { id: crypto.randomUUID(), name: `画板 ${boardsRef.current.length + 1}`, strokes: [], texts: [], deletedStrokeIds: [], deletedTextIds: [], epoch: INITIAL_BOARD_EPOCH, createdAt: Date.now() };
    const next = [...boardsRef.current, board].slice(0, 12);
    boardsRef.current = next;
    createAndSelect(board);
    setActiveMediaId("");
    broadcastRoomMessage({ type: "board-create", board });
  };

  const deleteBoard = async (id: string) => {
    if (!id || !boardsRef.current.some(board => board.id === id)) return;
    try {
      const response = await fetch('/api/room/boards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }), signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error('画板删除失败，请重试。');
      deletedBoardIdsRef.current.add(id);
      updateBoards(current => current.filter(board => board.id !== id));
      projection.fold();
      broadcastRoomMessage({ type: 'board-delete', id });
    } catch { setBoardNotice('画板删除暂未完成，请检查网络后重试。'); }
  };

  const addBoardStroke = (boardId: string, stroke: BoardStroke, epoch: string) => {
    const next = boardsRef.current.map((board) => {
      if (board.id !== boardId || board.epoch !== epoch || board.deletedStrokeIds.includes(stroke.id)) return board;
      const previous = board.strokes.find((item) => item.id === stroke.id);
      if (previous && previous.revision >= stroke.revision) return board;
      return { ...board, strokes: sortBoardStrokes(previous ? board.strokes.map((item) => item.id === stroke.id ? stroke : item) : [...board.strokes, stroke]) };
    });
    boardsRef.current = next; setBoards(next);
    broadcastRoomMessage({ type: "board-stroke-add", boardId, stroke, epoch });
  };

  const deleteBoardStroke = (boardId: string, strokeId: string, epoch: string) => {
    const next = boardsRef.current.map((board) => board.id === boardId && board.epoch === epoch
      ? { ...board, strokes: board.strokes.filter((stroke) => stroke.id !== strokeId), deletedStrokeIds: [...new Set([...board.deletedStrokeIds, strokeId])] }
      : board);
    boardsRef.current = next; setBoards(next);
    broadcastRoomMessage({ type: "board-stroke-delete", boardId, strokeId, epoch });
  };

  const clearBoard = (boardId: string) => {
    const observed = Number(boardsRef.current.find((board) => board.id === boardId)?.epoch.split(":")[0]) || 0;
    const epoch = `${Math.max(Date.now(), observed + 1).toString().padStart(13, "0")}:${crypto.randomUUID()}`;
    const next = boardsRef.current.map((board) => board.id === boardId ? { ...board, epoch, strokes: [], texts: [], deletedStrokeIds: [], deletedTextIds: [] } : board);
    boardsRef.current = next; setBoards(next);
    broadcastRoomMessage({ type: "board-clear", boardId, epoch });
  };

  const upsertBoardText = (boardId: string, text: BoardText, epoch: string) => {
    const next = boardsRef.current.map((board) => {
      if (board.id !== boardId || board.epoch !== epoch || board.deletedTextIds.includes(text.id)) return board;
      const previous = board.texts.find((item) => item.id === text.id);
      if (previous && previous.revision >= text.revision) return board;
      return { ...board, texts: previous ? board.texts.map((item) => item.id === text.id ? text : item) : [...board.texts, text].slice(-200) };
    });
    boardsRef.current = next; setBoards(next);
    broadcastRoomMessage({ type: "board-text-upsert", boardId, text, epoch });
  };

  const deleteBoardText = (boardId: string, textId: string, epoch: string) => {
    const next = boardsRef.current.map((board) => board.id === boardId && board.epoch === epoch
      ? { ...board, texts: board.texts.filter((text) => text.id !== textId), deletedTextIds: [...new Set([...board.deletedTextIds, textId])] }
      : board);
    boardsRef.current = next; setBoards(next);
    broadcastRoomMessage({ type: "board-text-delete", boardId, textId, epoch });
  };

  useEffect(() => {
    if (!joined) return;
    let disposed = false;
    void fetch("/api/cloud", { cache: "no-store" }).then(async (response) => {
      if (!response.ok || disposed) return;
      const result = await response.json() as { status?: CloudStatus };
      if (!disposed && result.status) setCloudStatus(result.status);
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [joined]);

  useEffect(() => {
    microphoneStreamRef.current = microphoneStream;
    outgoingCallsRef.current.forEach((call,key) => { if(key.startsWith('microphone:')) {call.close();outgoingCallsRef.current.delete(key);} });
    if(microphoneStream) dataConnectionsRef.current.forEach((_connection,peerId) => callPeerRef.current(peerId,microphoneStream,'microphone'));
    const track=microphoneStream?.getAudioTracks()[0];
    const resume=()=>recoverPublishedMediaRef.current('microphone');
    const visible=()=>{if(!document.hidden)resume();};
    track?.addEventListener('unmute',resume);window.addEventListener('focus',resume);document.addEventListener('visibilitychange',visible);
    return ()=>{track?.removeEventListener('unmute',resume);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',visible);microphoneStream?.getTracks().forEach(item=>item.stop());};
  },[microphoneStream]);
  const stopMicrophone = () => {
    microphoneRequest.current += 1;
    microphoneBusy.current = false;
    microphoneStreamRef.current?.getTracks().forEach(track=>{void roomRef.current?.localParticipant.unpublishTrack(track);track.stop();});
    microphoneStreamRef.current=null;setMicrophoneStream(null);
  };
  const toggleMicrophone = async () => {
    if(microphoneStreamRef.current){stopMicrophone();return;}
    if(microphoneBusy.current || !joined)return;
    microphoneBusy.current=true;setMicrophoneError('');let capture:MediaStream|null=null;
    const request = ++microphoneRequest.current;
    const owner = roomRef.current;
    const cancelled = () => request !== microphoneRequest.current || intentionalLeaveRef.current;
    const release = () => capture?.getTracks().forEach(track => { void owner?.localParticipant.unpublishTrack(track).catch(() => undefined); track.stop(); });
    try {
      capture=await navigator.mediaDevices.getUserMedia({video:false,audio:{echoCancellation:true,noiseSuppression:true}});
      if (cancelled()) { release(); return; }
      const track=capture.getAudioTracks()[0];
      if (!track) throw new Error('没有可用音轨');
      await owner?.localParticipant.publishTrack(track,{source:Track.Source.Microphone});
      if (cancelled() || (USE_LIVEKIT && owner !== roomRef.current)) { release(); return; }
      microphoneStreamRef.current=capture;setMicrophoneStream(capture);
      track.addEventListener('ended',()=>{if(microphoneStreamRef.current===capture){void roomRef.current?.localParticipant.unpublishTrack(track);microphoneStreamRef.current=null;setMicrophoneStream(null);}});
    }catch {release();if (!cancelled()) setMicrophoneError('麦克风暂时无法开启，请检查浏览器权限与设备占用');}
    finally{if (request === microphoneRequest.current) microphoneBusy.current=false;}
  };
  useEffect(() => () => { microphoneRequest.current += 1; microphoneBusy.current = false; }, [joined]);

  const stopCamera = () => {
    cameraStream?.getTracks().forEach((track) => { void roomRef.current?.localParticipant.unpublishTrack(track); track.stop(); });
    setCameraStream(null);
  };

  const toggleCamera = async () => {
    if (cameraStream) {
      stopCamera();
      return;
    }

    setCameraError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("当前浏览器不支持摄像头访问，请使用最新版 Chrome、Edge 或 Safari。");
      return;
    }

    try {
      const nextCameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 24, max: 30 },
          facingMode: "user",
        },
        audio: false,
      });
      const track = nextCameraStream.getVideoTracks()[0];
      track?.addEventListener("ended", () => { if (track) void roomRef.current?.localParticipant.unpublishTrack(track); setCameraStream(null); });
      if (track) await roomRef.current?.localParticipant.publishTrack(track, { source: Track.Source.Camera });
      setCameraStream(nextCameraStream);
      setActiveMediaId("self-camera");
      projection.reveal();
    } catch (error) {
      const name = (error as DOMException).name;
      setCameraError(name === "NotAllowedError"
        ? "摄像头权限未开启，请在浏览器地址栏允许 11scat 使用摄像头。"
        : "摄像头暂时无法开启，请确认没有被其他程序占用。");
    }
  };

  const submitActivity = async (event: FormEvent) => {
    event.preventDefault();
    if (activitySavingRef.current) return;
    const input = event.currentTarget.querySelector("input, textarea") as HTMLInputElement | HTMLTextAreaElement | null;
    const nextActivity = activity.trim().slice(0, 80);
    activitySavingRef.current = true;
    setActivitySaveStatus("正在保存…");
    try {
      const response = await fetch("/api/identity/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activity: nextActivity }),
        signal: AbortSignal.timeout(15_000),
        keepalive: true,
      });
      if (!response.ok) throw new Error("save failed");
    } catch {
      activitySavingRef.current = false;
      setActivitySaveStatus("保存失败，请按 Enter 重试");
      return;
    }
    activitySavingRef.current = false;
    activityRef.current = nextActivity;
    setActivity(nextActivity);
    setActivitySaveStatus("");
    void roomRef.current?.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ type: "activity", activity: nextActivity })),
      { reliable: true },
    ).catch(() => undefined);
    dataConnectionsRef.current.forEach((connection) => {
      try {
        if (connection.open) connection.send({ type: "activity", activity: nextActivity });
      } catch { /* The saved activity is sent again on reconnect. */ }
    });
    input?.blur();
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
    const response = await fetch(`/api/chat/messages/${encodeURIComponent(message.id)}`, { method: "DELETE" });
    if (!response.ok) {
      setChatImageError("撤回失败，请重试");
      return;
    }
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
    setChatSending(true);
    setMessages((current) => current.map((message) => message.id === id ? { ...message, delivery: "sending", error: undefined } : message));
    try {
      if (!item.attachment && item.file) item.attachment = await uploadChatFile(item.file);
      const response = await fetch("/api/chat/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-device-id": pushDeviceIdRef.current },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ id, body: item.message.body, attachment: item.attachment, replyTo: item.message.replyTo }),
      });
      const result = await response.json().catch(() => null) as { message?: unknown; error?: unknown } | null;
      const message = normalizeIncomingMessage(result?.message, identityIdRef.current);
      if (!response.ok || !message) throw new Error(typeof result?.error === "string" ? result.error : "发送未确认，请重试");
      setMessages((current) => mergeChatMessages([message], current));
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
      setChatSending(sendingChatIdsRef.current.size > 0);
      if (!sendingChatIdsRef.current.size) setChatUploadProgress(null);
    }
  };

  const sendVoice = (file: File) => {
    const now = Date.now();
    const message: ChatMessage = {
      id: crypto.randomUUID(), body: "", replyTo: chatQuote || undefined,
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
      id: crypto.randomUUID(), body, replyTo: chatQuote || undefined,
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

  const visibleTasks = classroomTodoTasks(tasks, todoNow ?? 0);
  const visibleRemoteMembers = roomMembers;
  const groupedTaskMembers = new Map<string, string[]>();
  visibleRemoteMembers.forEach((peerId) => {
    if (!memberNames[peerId]) return;
    const identityKey = peerIdentityIds[peerId] || peerId;
    if (identityKey === identityId) return;
    groupedTaskMembers.set(identityKey, [...(groupedTaskMembers.get(identityKey) || []), peerId]);
  });
  const taskBoardGroups = [...groupedTaskMembers.entries()].map(([identityKey, peerIds]) => {
    const firstPeer = peerIds[0];
    const taskMap = new Map<string, SharedTask>();
    peerIds.flatMap((peerId) => memberTasks[peerId] || []).forEach((task) => taskMap.set(task.id, task));
    return {
      identityKey,
      nickname: memberNames[firstPeer] || "成员",
      tasks: classroomTodoTasks([...taskMap.values()], todoNow ?? 0),
      peerIds,
      activity: peerIds.map((peerId) => memberActivities[peerId]).find((value) => value?.trim()) || "...",
    };
  });
  const mediaItems: MediaItem[] = [];
  if (stream) mediaItems.push({ id: "self-screen", label: "你的屏幕", stream, kind: "screen", remote: false });
  if (cameraStream) mediaItems.push({ id: "self-camera", label: "你的摄像头", stream: cameraStream, kind: "camera", remote: false });
  visibleRemoteMembers.forEach((peerId) => {
    const memberName = memberNames[peerId] || peerId;
    if (remoteScreens[peerId]) mediaItems.push({ id: `${peerId}-screen`, label: `${memberName} 的屏幕`, stream: remoteScreens[peerId], kind: "screen", remote: true });
    if (remoteCameras[peerId]) mediaItems.push({ id: `${peerId}-camera`, label: `${memberName} 的摄像头`, stream: remoteCameras[peerId], kind: "camera", remote: true });
  });
  mediaItems.sort((left, right) => Number(right.kind === "screen") - Number(left.kind === "screen"));
  const activeMedia = mediaItems.find((item) => item.id === activeMediaId) || mediaItems[0];
  const orderedBoards = orderClassroomBoards(boards);
  const activeBoard = orderedBoards.find((board) => board.id === activeBoardId);
  const boardIndex = activeBoard ? orderedBoards.indexOf(activeBoard) + 1 : 0;
  const projection = useProjectionCurtain(activeMedia?.stream);

  const stepBoard = (direction: -1 | 1) => {
    setActiveBoardId(adjacentBoardId(boards, activeBoardId, direction)); projection.fold();
  };
  const stepMedia = (direction: -1 | 1) => {
    if (mediaItems.length < 2) return;
    const currentIndex = Math.max(0, mediaItems.findIndex((item) => item.id === activeMedia?.id));
    const nextIndex = (currentIndex + direction + mediaItems.length) % mediaItems.length;
    projection.reveal();
    setActiveMediaId(mediaItems[nextIndex].id);
  };

  if (!profileReady || !joined || !classroomProfile.ready) {
    return <RoomLoadingScreen displayName={displayName} error={joinError || classroomProfile.error} onRetry={() => window.location.reload()} />;
  }

  return (
    <main className="app-shell classroom-scene" id="top" data-device-font={classroomProfile.profile.font}>
      <section className="workspace">
        <section className="focus-stage panel">
          {roomError && <p className="room-error" role="alert">{roomError}</p>}
          <div className="share-canvas" ref={stageRef}><div className="stage-content">
            <ProjectorControl open={projection.open} hasSource={!!activeMedia} disabled={shareStarting} onClick={projection.toggle} />
            {!projection.open && <BlackboardSurface index={boardIndex} count={orderedBoards.length + 1} onStep={stepBoard} drawing={!!activeBoard}>
            {!activeBoard && <button className={`main-fullscreen-button${projection.open ? '' : ' is-chalk'}`} type="button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "退出主窗口全屏" : "主窗口全屏"} aria-keyshortcuts="f" ><ClassroomFullscreenIcon fullscreen={fullscreen} chalk={!projection.open} /></button>}
            {fullscreenError && <p className="main-fullscreen-error" role="alert">{fullscreenError}</p>}
            {activeBoard ? <Whiteboard key={activeBoard.id} board={activeBoard} onDelete={() => deleteBoard(activeBoard.id)} fullscreen={fullscreen} onToggleFullscreen={toggleFullscreen} onAddStroke={(stroke, epoch) => addBoardStroke(activeBoard.id, stroke, epoch)} onDeleteStroke={(strokeId, epoch) => deleteBoardStroke(activeBoard.id, strokeId, epoch)} onClear={() => clearBoard(activeBoard.id)} onUpsertText={(text, epoch) => upsertBoardText(activeBoard.id, text, epoch)} onDeleteText={(textId, epoch) => deleteBoardText(activeBoard.id, textId, epoch)} onSaved={(message, error) => {
              setBoardNotice(error ? "" : message);
              setShareError(error ? message : "");
              if (!error) window.setTimeout(() => setBoardNotice((current) => current === message ? "" : current), 3500);
            }} /> : !projection.open ? <IdleChalkboard date={classroomDate} tasks={publicTasks} /> : null}
            </BlackboardSurface>}
            {projection.open && <button className="main-fullscreen-button" type="button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? '退出主窗口全屏' : '主窗口全屏'}><ClassroomFullscreenIcon fullscreen={fullscreen} chalk={false} /></button>}
            <div className={projection.open ? "projection-sheet is-open" : "projection-sheet"} aria-hidden={!projection.open}>
              {activeMedia && projection.open && <>
              <MediaVideo
                className={`main-media ${activeMedia.kind}${activeMedia.remote ? " remote" : ""}`}
                stream={activeMedia.stream}
                label={activeMedia.label}
                muted={!activeMedia.remote || activeMedia.kind !== "screen" || remoteScreenMuted}
                onAudioBlocked={activeMedia.remote && activeMedia.kind === "screen" ? markRemoteAudioBlocked : undefined}
              />
              {mediaItems.length > 1 && <>
                <button className="media-nav media-prev" type="button" onClick={() => stepMedia(-1)} aria-label="查看上一个画面"><ChevronLeft aria-hidden="true" /></button>
                <button className="media-nav media-next" type="button" onClick={() => stepMedia(1)} aria-label="查看下一个画面"><ChevronRight aria-hidden="true" /></button>
              </>}
              <div className="media-caption">{activeMedia.label}<span>{mediaItems.findIndex((item) => item.id === activeMedia.id) + 1} / {mediaItems.length}</span></div>
              {activeMedia.kind === "screen" && <div className="media-window-actions">
                {activeMedia.id === "self-screen" && <span className={activeMedia.stream.getAudioTracks().length ? "share-audio-status active" : "share-audio-status"}>{activeMedia.stream.getAudioTracks().length ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}{activeMedia.stream.getAudioTracks().length ? "正在共享电脑音频" : "未共享电脑音频"}</span>}
                {activeMedia.remote && activeMedia.stream.getAudioTracks().length > 0 && <button className="remote-audio-button" type="button" onClick={toggleRemoteScreenAudio} aria-label={remoteScreenMuted || remoteAudioBlocked ? "播放共享声音" : "静音共享声音"}>{remoteScreenMuted || remoteAudioBlocked ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}{remoteScreenMuted || remoteAudioBlocked ? "播放声音" : "静音"}</button>}
                {activeMedia.remote && activeMedia.stream.getAudioTracks().length === 0 && <span className="share-audio-status"><VolumeX aria-hidden="true" />未共享电脑音频</span>}
                <button className={pictureInPicture ? "picture-in-picture-button active" : "picture-in-picture-button"} type="button" onClick={() => void togglePictureInPicture()} aria-label={pictureInPicture ? "关闭小窗" : "开启小窗"}><PictureInPicture2 size={18} aria-hidden="true" />{pictureInPicture ? "关闭小窗" : "小窗"}</button>
              </div>}
              {activeMedia.kind === "camera" && <div className="media-window-actions">
                {activeMedia.id === "self-camera" && <button type="button" onClick={() => void toggleCamera()}><Camera size={16} aria-hidden="true" />关闭摄像头</button>}
              </div>}

              </>}
            </div>
          </div></div>
          {boardNotice && <p className="board-notice" role="status">{boardNotice}</p>}
          {(shareError || cameraError) && <p className="error-message" role="alert">{shareError || cameraError}</p>}

        </section>

        <aside className="side-panel panel">
          <div className="side-tabs" aria-label="侧栏内容">
            <button className={sideView === "chat" ? "active" : ""} onClick={() => setSideView("chat")}><MessageCircle size={18} aria-hidden="true" />传纸条</button>
            <button className={sideView === "tasks" ? "active" : ""} onClick={() => setSideView("tasks")}><ListTodo size={18} aria-hidden="true" />今日任务</button>
            <div className="chat-bell-host" ref={setBellHost} />
          </div>

          {sideView === "chat" ? <div className="chat-view">
            <div className="message-list" ref={messageListRef} onScroll={handleChatScroll} aria-live="polite">
              {chatHistoryLoading && <div className="chat-history-status">正在加载聊天记录…</div>}
              {!chatHistoryLoading && chatHistoryReady && !chatHistoryCursor && messages.length > 0 && <div className="chat-history-status">已经到最早一条了</div>}
              {messages.length === 0 ? <div className="empty-chat"><strong>还没有消息</strong></div> : messages.map((message) => (
                <div
                  className={message.own ? "message own" : "message"}
                  key={message.id}
                  onPointerDown={(event) => startMessageLongPress(event, message.id)}
                  onPointerMove={moveMessageLongPress}
                  onPointerUp={clearLongPressTimer}
                  onPointerCancel={clearLongPressTimer}
                  onContextMenu={(event) => {
                    if ((event.target as Element).closest("audio, .voice-player button, .voice-player input, .voice-player a")) return;
                    event.preventDefault();
                    clearLongPressTimer();
                    longPressTriggeredRef.current = false;
                    const listTop = messageListRef.current?.getBoundingClientRect().top || 0;
                    setMessageMenuPlacement(event.currentTarget.getBoundingClientRect().top - listTop > 145 ? "above" : "below");
                    setMessageMenuId(message.id);
                  }}
                  onClickCapture={(event) => {
                    if (!longPressTriggeredRef.current) return;
                    if ((event.target as Element).closest(".message-action-menu")) {
                      longPressTriggeredRef.current = false;
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    longPressTriggeredRef.current = false;
                  }}
                >
                  <span>{message.sender} · {formatChatTime(message)}</span>
                  {messageMenuId === message.id && <div className={`message-action-menu ${messageMenuPlacement}${message.own ? " own" : ""}`} role="menu" onPointerDown={(event) => event.stopPropagation()}>
                    {message.own && <button type="button" role="menuitem" onClick={() => void recallMessage(message)}><Undo2 size={18} aria-hidden="true" />撤回</button>}
                    <button type="button" role="menuitem" onClick={() => quoteMessage(message)}><Quote size={18} aria-hidden="true" />引用</button>
                    <button type="button" role="menuitem" onClick={() => void copyMessage(message)}><Copy size={18} aria-hidden="true" />复制</button>
                  </div>}
                  {message.replyTo && <div className="message-quote"><strong>{message.replyTo.sender}</strong><span>{message.replyTo.body}</span></div>}
                  {message.attachment?.kind === "image" && <div className="message-image-wrap">
                    <button className="message-image-link" type="button" onClick={() => openChatImage({ url: message.attachment!.url, name: message.attachment!.name })} aria-label="查看原图" aria-haspopup="dialog">
                      <img className="message-image" src={message.attachment.url} alt={message.attachment.name} loading="lazy" onLoad={() => { if (chatAtBottomRef.current) scrollChatToBottom("auto"); }} />
                    </button>
                    <CloudSaveButton state={chatCloudUploads[message.attachment.id]} onClick={() => void uploadChatImageToCloud(message.attachment!)} />
                  </div>}
                  {message.attachment?.kind === "audio" && <div className="message-audio">
                    <AudioPlayer key={message.attachment.url} src={message.attachment.url} name={message.attachment.name} />
                    <CloudSaveButton state={chatCloudUploads[message.attachment.id]} onClick={() => void uploadChatImageToCloud(message.attachment!)} />
                  </div>}
                  {message.attachment?.kind === "file" && <a className="message-file" href={message.attachment.url} download={message.attachment.name}>
                    <Download className="message-file-icon" size={20} aria-hidden="true" />
                    <span><strong>{message.attachment.name}</strong><small>{formatFileSize(message.attachment.size)}</small></span>
                  </a>}
                  {message.imageUrl && <div className="message-image-wrap">
                    <button className="message-image-link" type="button" onClick={() => openChatImage({ url: message.imageUrl!, name: `${message.sender} 发送的图片` })} aria-label="查看原图" aria-haspopup="dialog">
                      <img className="message-image" src={message.imageUrl} alt={`${message.sender} 发送的图片`} loading="lazy" onLoad={() => { if (chatAtBottomRef.current) scrollChatToBottom("auto"); }} />
                    </button>
                    {(() => { const id = message.imageUrl!.split("/").pop() || ""; return <CloudSaveButton state={chatCloudUploads[id]} onClick={() => void uploadChatImageToCloud({ id, url: message.imageUrl!, name: "聊天图片", size: 0, mimeType: "image/*", kind: "image" })} />; })()}
                  </div>}
                  {message.body && <p>{message.body}</p>}
                  {message.delivery && <div className="message-delivery" role="status">
                    <span>{message.delivery === "sending" ? "发送中…" : "发送未确认"}{!message.body && outgoingChatRef.current.get(message.id)?.file ? " · " + outgoingChatRef.current.get(message.id)?.file?.name : ""}</span>
                    {message.delivery === "failed" && <button type="button" aria-label={message.error} onClick={() => { const item = outgoingChatRef.current.get(message.id); if (item) void deliverChat(item); }}>重试</button>}
                  </div>}
                </div>
              ))}
            </div>
            <form className="chat-form" onSubmit={sendMessage}>
              {chatQuote && <div className="chat-quote-preview">
                <span><strong>回复 {chatQuote.sender}</strong>{chatQuote.body}</span>
                <button type="button" onClick={() => setChatQuote(null)} aria-label="取消引用" ><X size={18} aria-hidden="true" /></button>
              </div>}
              {chatImagePreview && <div className="chat-image-preview">
                <img src={chatImagePreview} alt="待发送图片预览" />
                <span>{chatImage?.name}</span>
                <button type="button" onClick={clearChatImage} aria-label="移除待发送附件" ><X size={18} aria-hidden="true" /></button>
              </div>}
              {chatImage && !chatImagePreview && <div className="chat-file-preview"><File size={24} aria-hidden="true" /><div><strong>{chatImage.name}</strong><small>{formatFileSize(chatImage.size)}</small></div><button type="button" onClick={clearChatImage} aria-label="移除待发送附件" ><X size={18} aria-hidden="true" /></button></div>}
              <div className="chat-input-row">
                <input
                  ref={chatImageInputRef}
                  className="chat-image-input"
                  type="file"
                  onChange={(event) => {
                    selectChatImage(event.target.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                  tabIndex={-1}
                />
                <button className="chat-attach-button" type="button" onClick={() => chatImageInputRef.current?.click()} aria-label="发送图片或文件" >
                  <Paperclip size={20} aria-hidden="true" />
                </button>
                <VoiceRecorder onRecorded={sendVoice} onError={setChatImageError} />
                <textarea
                  value={chatDraft}
                  onChange={(event) => setChatDraft(event.target.value)}
                  onPaste={(event) => {
                    const file = Array.from(event.clipboardData.files)[0];
                    if (file) selectChatImage(file);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  aria-label="输入房间消息"
                  rows={2}
                />
                <button className="primary-button chat-send-button" type="submit" onClick={sendMessage} disabled={!chatDraft.trim() && !chatImage}>发送</button>
              </div>
              {chatUploadProgress !== null && <div className="chat-upload-progress" role="status"><span style={{ width: `${chatUploadProgress}%` }} /><small>{chatUploadProgress < 100 ? `正在上传 ${chatUploadProgress}%` : "上传完成，正在发送…"}</small></div>}
              {chatImageError && <p className="chat-image-error" role="alert">{chatImageError}</p>}
            </form>
          </div> : <div className="task-view">
            {syncError && <p className="error-message" role="alert">{syncError}</p>}

            <div className="task-scroll">
              <ClassroomTodoCard name={displayName || '你'} tasks={visibleTasks}
                note={classroomProfile.profile.members.find(member=>member.id===identityId)?.todoNote || ''}
                onNoteSave={async note => {
                  const response = await fetch('/api/room/todo', {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({note})});
                  if (!response.ok) throw new Error('小记保存失败');
                  window.dispatchEvent(new Event('classroom-settings-changed')); broadcastRoomMessage({type:'classroom-settings-changed'});
                }}
                onComplete={task=>void toggleTask(task)} headerActions={<NewMemberTasks identityId={identityId} onChanged={loadTasks} />}
                empty={!syncing && !connected ? <div className="ticktick-connect-empty"><button className="primary-button" type="button" onClick={()=>setSyncOpen(true)}>连接滴答</button></div> : undefined} />
              {taskBoardGroups.slice(0,1).map(group=><ClassroomTodoCard key={group.identityKey} name={group.nickname} tasks={group.tasks} note={classroomProfile.profile.members.find(member=>member.id===group.identityKey)?.todoNote || ''} />)}
              {!taskBoardGroups.length && <ClassroomTodoCard name={classroomProfile.profile.members.find(member=>member.id!==identityId)?.name || '同桌'} tasks={[]} empty={<p className="task-empty">等待同桌的任务</p>} />}
            </div>
          </div>}
        </aside>
      </section>

      <div className="scene-desks">
        {fixedClassroomSeats(classroomProfile.profile).map((member, index) => {
          const peers = memberDevices(member.id, roomMembers, peerIdentityIds);
          const self = member.id === identityId;
          const screenPeer = peers.find(id => remoteScreens[id]);
          const cameraPeer = peers.find(id => remoteCameras[id]);
          const screenOn = !!((self && stream) || screenPeer);
          const cameraOn = !!((self && cameraStream) || cameraPeer);
          const view = (id: string) => { setActiveMediaId(id); projection.reveal(); };
          return <div className="classroom-desk" key={index}><DeviceCard font={classroomProfile.profile.font} kind={index === 0 ? 'tablet' : 'laptop'} name={self ? displayName : member.name} online={!!member.id && ((self && joined) || peers.length > 0)} screen={screenOn} camera={cameraOn} microphone={self ? !!microphoneStream : peers.some(id=>!!remoteMicrophones[id])} self={self} onMicrophone={self ? ()=>void toggleMicrophone() : undefined}
            onScreen={self ? () => stream ? stopShare() : screenPeer ? view(screenPeer + '-screen') : void startShare() : screenPeer ? () => view(screenPeer + '-screen') : undefined}
            onCamera={self ? () => cameraStream ? stopCamera() : cameraPeer ? view(cameraPeer + '-camera') : void toggleCamera() : cameraPeer ? () => view(cameraPeer + '-camera') : undefined}>
            {self ? <form className="activity-box" onSubmit={submitActivity}><ActivityInput value={activity} readOnly={activitySaveStatus === '正在保存…'} onChange={value => { setActivity(value); setActivitySaveStatus(''); }} />{activitySaveStatus && <small role="status">{activitySaveStatus}</small>}</form> : <p>{peers.map(id => memberActivities[id]).find(value => value !== undefined) ?? member.activity}</p>}
          </DeviceCard></div>;
        })}
        <div className="classroom-desk desk-media">
          <button className="object-button" type="button" onClick={createBoard} aria-label="画板"  aria-pressed={!!activeBoard}><ClassroomProp name="chalk-cup" /></button>
          <button className="object-button calendar-entry-button" type="button" aria-label="双人日历" ><ClassroomProp name="calendar-entry" /></button>
          <RoomCollaboration key={identityId} identityId={identityId} onChanged={loadTasks} onNotice={playNotificationSound} onPublicTasks={setPublicTasks} triggerContent={<ClassroomProp name="taskboard" />} />

        </div>
        <div className="classroom-desk desk-room">
          <button className="object-button cloud-entry-button" type="button" onClick={openCloud} aria-label="云盘" ><ClassroomProp name="folder" /></button>
          <ClassroomSettings profile={classroomProfile.profile} identityId={identityId} onSave={classroomProfile.save} error={classroomProfile.error} triggerContent={<ClassroomProp name="settings" />} notifications={<>
            <button type="button" disabled={pushBusy || pushTesting} onClick={() => void (pushEnabled ? disablePushNotifications() : enablePushNotifications())}>{pushBusy ? "处理中…" : pushEnabled ? "关闭此设备提醒" : "开启此设备提醒"}</button>
            <button type="button" disabled={pushBusy || pushTesting || !pushEnabled} onClick={() => void testPushNotifications()}>{pushTesting ? "测试中…" : "发送测试提醒"}</button>
            {(pushMessage || pushTestMessage) && <p role="status">{pushTestMessage || pushMessage}</p>}
          </>} />
        </div>
      </div>

      <EmergencyExit onClick={() => { intentionalLeaveRef.current = true; stopShare(); stopCamera(); stopMicrophone(); window.location.assign("/access"); }} />
      {Object.entries(remoteMicrophones).filter(([peer]) => peerIdentityIds[peer] !== identityId).map(([peer,media]) => <RemoteMicrophone key={peer} stream={media} />)}
      {microphoneError && <p className="room-microphone-error" role="alert">{microphoneError}</p>}
      <RoomBell triggerHost={bellHost} onShowChat={showBellChat} />
      {profileReady && !joined && <p className="error-message" role="alert">{joinError || "正在进入自习室…"}</p>}

      {cloudOpen && <CloudDrive onClose={() => setCloudOpen(false)} onStatusChange={setCloudStatus} onImage={openChatImage} />}

      {viewedChatImage && <ChatImageViewer image={viewedChatImage} onClose={closeChatImage} />}

      {syncOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSyncOpen(false)}>
          <section className="sync-modal" role="dialog" aria-modal="true" aria-labelledby="sync-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setSyncOpen(false)} aria-label="关闭" ><X size={18} aria-hidden="true" /></button>
            <span className="ticktick-mark"><Check size={24} aria-hidden="true" /></span><span className="eyebrow">REAL TICKTICK CONNECTION</span>
            <h2 id="sync-title">连接你的滴答清单</h2>
            <p>Token 会按身份加密保存在服务器中，用于读取任务和同步完成状态。以后使用同一身份识别码时会自动恢复。</p>
            {connected ? (
              <div className="connected-actions"><button className="primary-button wide" onClick={() => { setSyncOpen(false); void loadTasks(); }}>立即刷新</button><button className="disconnect-button" onClick={() => void disconnectTickTick()}>断开滴答清单</button></div>
            ) : (
              <form onSubmit={connectTickTick}>
                <label className="token-label">滴答 API Token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" placeholder="粘贴 Token" required /></label>
                {syncError && <p className="error-message">{syncError}</p>}
                <button className="primary-button wide" type="submit">验证并连接</button>
              </form>
            )}
            <TickTickDiagnostics />
            <a className="oauth-link" href="https://dida365.com/webapp/#settings/account" target="_blank" rel="noreferrer">前往滴答网页端：头像 → 设置 → 账户与安全 → API 口令</a>
          </section>
        </div>
      )}
    </main>
  );
}
