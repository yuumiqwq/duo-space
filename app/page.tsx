"use client";

import { Room } from "livekit-client";
import { Camera,Check,ChevronLeft,ChevronRight,Copy,Download,File,ListTodo,MessageCircle,Paperclip,PictureInPicture2,Quote,Undo2,Volume2,VolumeX,X } from "lucide-react";
import type { DataConnection,MediaConnection,Peer as PeerClient } from "peerjs";
import { FormEvent,useCallback,useEffect,useRef,useState } from "react";
import { AudioPlayer } from "./AudioPlayer";
import { ChatImageViewer } from "./ChatImageViewer";
import { ActivityInput,ClassroomSettings,DeviceCard } from './ClassroomDevices';
import { BlackboardSurface,ClassroomFullscreenIcon,ClassroomProp,EmergencyExit,IdleChalkboard,ProjectorControl,useClassroomDate,useProjectionCurtain } from "./ClassroomScene";
import { ClassroomTodoCard,useClassroomTodoClock } from "./ClassroomTodo";
import { CloudDrive } from "./CloudDrive";
import { CloudSaveButton } from "./CloudSaveButton";
import { NewMemberTasks } from "./MemberTasks";
import { RemoteRoomAudio } from "./RemoteMicrophone";
import { RoomBell } from "./RoomBell";
import { RoomCollaboration } from "./RoomCollaboration";
import { RoomLoadingScreen } from './RoomLoadingScreen';
import { TickTickDiagnostics } from "./TickTickDiagnostics";
import { VoiceRecorder } from "./VoiceRecorder";
import { Whiteboard } from "./Whiteboard";
import { adjacentBoardId,orderClassroomBoards } from "./classroom-boards";
import { loadClassroomPublicTasks } from './classroom-entry';
import { prepareClassroomAssets } from './classroom-loading';
import { fixedClassroomSeats,memberDevices } from './classroom-members';
import { classroomTodoTasks,classroomTodoWindow } from "./classroom-todo";
import { type PublicTaskPreview } from "./classroom-view";
import "./classroom.css";
import "./main-fullscreen.css";
import { type MediaSource } from "./media-recovery";
import { encodeRoomPackets } from "./room-packets";
import { MediaVideo } from './room/MediaVideo';
import { formatChatTime,formatFileSize,MediaItem,SharedTask } from './room/model';
import { useLiveKitRoom } from './room/use-livekit-room';
import { usePeerRoom } from './room/use-peer-room';
import { useRoomBoards } from './room/use-room-boards';
import { useRoomChat } from './room/use-room-chat';
import { useRoomNotifications } from './room/use-room-notifications';
import { useRoomTasks } from './room/use-room-tasks';
import { useClassroomEntry } from './use-classroom-entry';
import { useClassroomProfile } from './use-classroom-profile';
import { useMainFullscreen } from "./use-main-fullscreen";

import { useRoomMedia } from "./room/use-room-media";
import { useRoomPresence } from "./room/use-room-presence";

export default function Home() {

  const classroomDate = useClassroomDate();
  const todoNow = useClassroomTodoClock();
  const today = todoNow ? classroomTodoWindow(todoNow).day : "";
  const [publicTasks, setPublicTasks] = useState<PublicTaskPreview[]>([]);
  const [remoteMicrophones, setRemoteMicrophones] = useState<Record<string, MediaStream>>({});
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
  const [roomError, setRoomError] = useState("");
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
  const [cloudOpen, setCloudOpen] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const peerRef = useRef<PeerClient | null>(null);
  const selfPeerIdRef = useRef("");
  const hostPeerIdRef = useRef("");
  const dataConnectionsRef = useRef(new Map<string, DataConnection>());
  const activityRef = useRef("");
  const outgoingCallsRef = useRef(new Map<string, MediaConnection>());
  const incomingCallsRef = useRef(new Map<string, MediaConnection>());
  const callPeerRef = useRef<(peerId: string, media: MediaStream, source: MediaSource) => void>(() => undefined);
  const recoverPublishedMediaRef = useRef<(source: MediaSource) => void>(() => undefined);
  const displayNameRef = useRef("");
  const identityIdRef = useRef("");
  const memberNamesRef = useRef<Record<string, string>>({});
  const intentionalLeaveRef = useRef(false);
  const { participants: presentMembers, deviceIdRef: presenceDeviceIdRef, syncPresence } = useRoomPresence({ joined, selfPeerIdRef, displayNameRef, intentionalLeaveRef });
  const { microphoneStreamRef, cameraStreamRef, screenStreamRef, stream, shareStarting, remoteScreenMuted, pictureInPicture, shareError, setShareError, microphoneStream, microphoneError, cameraStream, cameraError, startShare: captureScreen, stopShare, toggleRemoteScreenAudio, togglePictureInPicture, stopMicrophone, toggleMicrophone, stopCamera, toggleCamera: toggleCapture } = useRoomMedia({ outgoingCallsRef, dataConnectionsRef, callPeerRef, recoverPublishedMediaRef, roomRef, intentionalLeaveRef, setActiveMediaId, joined });


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
  const { pushStatus, setPushStatus, setPushCheckVersion, pushBusy, pushTesting, pushTestMessage, pushMessage, pushDeviceIdRef, playNotificationSound, enablePushNotifications, disablePushNotifications, testPushNotifications } = useRoomNotifications({ identityId });
  const { boards, activeBoardId, setActiveBoardId, boardNotice, setBoardNotice, boardsRef, deletedBoardIdsRef, refreshDeletedBoards, receiveBoardMessage, createBoard: createRoomBoard, deleteBoard: deleteRoomBoard, addBoardStroke, deleteBoardStroke, clearBoard, upsertBoardText, deleteBoardText } = useRoomBoards({ joined, broadcastRoomMessage });
  const { tasks, syncOpen, setSyncOpen, connected, syncing, syncError, token, setToken, tasksRef, loadTasks, toggleTask, connectTickTick, disconnectTickTick } = useRoomTasks({ today });


  const classroomProfile = useClassroomProfile(joined, broadcastRoomMessage);
  const { messages, setMessages, chatDraft, setChatDraft, chatImage, chatImagePreview, viewedChatImage, chatImageError, setChatImageError, chatUploadProgress, chatHistoryLoading, chatHistoryCursor, chatHistoryReady, chatQuote, setChatQuote, messageMenuId, setMessageMenuId, messageMenuPlacement, setMessageMenuPlacement, chatCloudUploads, chatImageInputRef, messageListRef, longPressTriggeredRef, chatAtBottomRef, recalledChatIdsRef, outgoingChatRef, scrollChatToBottom, openChatImage, closeChatImage, handleChatScroll, uploadChatImageToCloud, clearChatImage, selectChatImage, clearLongPressTimer, startMessageLongPress, moveMessageLongPress, recallMessage, quoteMessage, copyMessage, deliverChat, sendVoice, sendMessage } = useRoomChat({ sideView, classroomReady: classroomProfile.ready, identityIdRef, playNotificationSound, joined, roomRef, dataConnectionsRef, pushDeviceIdRef, displayNameRef, displayName });
  useLiveKitRoom({ joined, roomRef, setRoomMembers, setMemberNames, setPeerIdentityIds, setRemoteMicrophones, setRemoteCameras, setRemoteScreens, activityRef, broadcastRoomMessage, boardsRef, deletedBoardIdsRef, setMemberTasks, setMemberActivities, receiveBoardMessage, recalledChatIdsRef, outgoingChatRef, setMessages, identityIdRef, playNotificationSound, setRoomError, displayName });
  usePeerRoom({ joined, dataConnectionsRef, outgoingCallsRef, incomingCallsRef, microphoneStreamRef, screenStreamRef, cameraStreamRef, recoverPublishedMediaRef, setRoomError, hostPeerIdRef, displayNameRef, setMemberNames, setPeerIdentityIds, setRoomMembers, setRemoteMicrophones, setRemoteCameras, setRemoteScreens, setMemberTasks, setMemberActivities, identityIdRef, callPeerRef, selfPeerIdRef, activityRef, tasksRef, boardsRef, deletedBoardIdsRef, receiveBoardMessage, recalledChatIdsRef, outgoingChatRef, setMessages, memberNamesRef, playNotificationSound, setActiveMediaId, peerRef, presenceDeviceIdRef, syncPresence });

  const { root: entryRoot, ready: entryReady, error: entryError } = useClassroomEntry(profileReady && joined && classroomProfile.ready && chatHistoryReady);

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
        const publicTasks = loadClassroomPublicTasks().then(tasks => { if (!disposed) setPublicTasks(tasks); });
        await Promise.all([profile, prepareClassroomAssets(), refreshDeletedBoards(), publicTasks]);
        if (!disposed) setJoined(true);
      } catch (error) {
        console.error('Classroom entry preparation failed', error);
        if (!disposed) setJoinError(error instanceof Error && error.message !== 'profile unavailable' ? error.message : "暂时无法读取身份资料，请重试。");
      } finally {
        if (!disposed) setProfileReady(true);
      }
    };
    void loadProfile();
    return () => { disposed = true; };
  }, [refreshDeletedBoards]);


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
  }, [tasks, tasksRef]);
  useEffect(() => { displayNameRef.current = displayName.trim(); }, [displayName]);
  useEffect(() => { memberNamesRef.current = memberNames; }, [memberNames]);

  const openCloud = () => setCloudOpen(true);

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
  const createBoard = () => { if (createRoomBoard()) { projection.fold(); setActiveMediaId(""); } };
  const deleteBoard = async (id: string) => { if (await deleteRoomBoard(id)) projection.fold(); };
  const startShare = () => captureScreen(projection.reveal);
  const toggleCamera = () => toggleCapture(projection.reveal);

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
    <>
    <main ref={entryRoot} className="app-shell classroom-scene" id="top" data-device-font={classroomProfile.profile.font} inert={!entryReady} aria-hidden={!entryReady || undefined}>
      <section className="workspace">
        <section className="focus-stage panel">
          {roomError && <p className="room-error" role="alert">{roomError}</p>}
          <div className="share-canvas" ref={stageRef}><div className="stage-content">
            <ProjectorControl open={projection.open} hasSource={!!activeMedia} disabled={shareStarting} onClick={projection.toggle} />
            {!projection.open && <BlackboardSurface index={boardIndex} count={orderedBoards.length + 1} onStep={stepBoard} drawing={!!activeBoard}>
            {!activeBoard && <button className={`main-fullscreen-button${projection.open ? '' : ' is-chalk'}`} type="button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "退出主窗口全屏" : "主窗口全屏"} aria-keyshortcuts="f" ><ClassroomFullscreenIcon fullscreen={fullscreen} chalk={!projection.open} /></button>}
            {fullscreenError && <p className="main-fullscreen-error" role="alert">{fullscreenError}</p>}
            {activeBoard ? <Whiteboard key={activeBoard.id} board={activeBoard} onDelete={() => deleteBoard(activeBoard.id)} fullscreen={fullscreen} onToggleFullscreen={toggleFullscreen} onAddStroke={(stroke, epoch, publish) => addBoardStroke(activeBoard.id, stroke, epoch, publish)} onDeleteStroke={(strokeId, epoch) => deleteBoardStroke(activeBoard.id, strokeId, epoch)} onClear={() => clearBoard(activeBoard.id)} onUpsertText={(text, epoch) => upsertBoardText(activeBoard.id, text, epoch)} onDeleteText={(textId, epoch) => deleteBoardText(activeBoard.id, textId, epoch)} onSaved={(message, error) => {
              setBoardNotice(error ? "" : message);
              setShareError(error ? message : "");
              if (!error) window.setTimeout(() => setBoardNotice((current) => current === message ? "" : current), 3500);
            }} /> : !projection.open ? <IdleChalkboard date={classroomDate} tasks={publicTasks} /> : null}
            </BlackboardSurface>}
            {projection.open && <button className="main-fullscreen-button" type="button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? '退出主窗口全屏' : '主窗口全屏'}><ClassroomFullscreenIcon fullscreen={fullscreen} chalk={false} /></button>}
            <div className={projection.open ? "projection-sheet is-open" : "projection-sheet"} aria-hidden={!projection.open}>
              {activeMedia && projection.open && <>
              <MediaVideo
                screen={activeMedia.kind === "screen"}
                className={`main-media ${activeMedia.kind}${activeMedia.remote ? " remote" : ""}`}
                stream={activeMedia.stream}
                label={activeMedia.label}
              />
              {mediaItems.length > 1 && <>
                <button className="media-nav media-prev" type="button" onClick={() => stepMedia(-1)} aria-label="查看上一个画面"><ChevronLeft aria-hidden="true" /></button>
                <button className="media-nav media-next" type="button" onClick={() => stepMedia(1)} aria-label="查看下一个画面"><ChevronRight aria-hidden="true" /></button>
              </>}
              <div className="media-caption">{activeMedia.label}<span>{mediaItems.findIndex((item) => item.id === activeMedia.id) + 1} / {mediaItems.length}</span></div>
              {activeMedia.kind === "screen" && <div className="media-window-actions">
                {activeMedia.id === "self-screen" && <span className={activeMedia.stream.getAudioTracks().length ? "share-audio-status active" : "share-audio-status"}>{activeMedia.stream.getAudioTracks().length ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}{activeMedia.stream.getAudioTracks().length ? "正在共享电脑音频" : "未共享电脑音频"}</span>}
                {activeMedia.remote && activeMedia.stream.getAudioTracks().length > 0 && <button className="remote-audio-button" type="button" onClick={toggleRemoteScreenAudio} aria-label={remoteScreenMuted ? "播放共享声音" : "静音共享声音"}>{remoteScreenMuted ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}{remoteScreenMuted ? "播放声音" : "静音"}</button>}
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
                    <span>{message.delivery === "sending" ? "发送中…" : "发送未确认"}{!message.body && message.pendingFileName ? " · " + message.pendingFileName : ""}</span>
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
          return <div className="classroom-desk" key={index}><DeviceCard font={classroomProfile.profile.font} kind={index === 0 ? 'tablet' : 'laptop'} name={self ? displayName : member.name} online={!!member.id && ((self && joined) || presentMembers.some(item => item.identityId === member.id))} screen={screenOn} camera={cameraOn} microphone={self ? !!microphoneStream : peers.some(id=>!!remoteMicrophones[id])} self={self} onMicrophone={self ? ()=>void toggleMicrophone() : undefined}
            onScreen={self ? () => stream ? stopShare() : screenPeer ? view(screenPeer + '-screen') : void startShare() : screenPeer ? () => view(screenPeer + '-screen') : undefined}
            onCamera={self ? () => cameraStream ? stopCamera() : cameraPeer ? view(cameraPeer + '-camera') : void toggleCamera() : cameraPeer ? () => view(cameraPeer + '-camera') : undefined}>
            {self ? <form className="activity-box" onSubmit={submitActivity}><ActivityInput value={activity} readOnly={activitySaveStatus === '正在保存…'} onChange={value => { setActivity(value); setActivitySaveStatus(''); }} />{activitySaveStatus && <small role="status">{activitySaveStatus}</small>}</form> : <p>{peers.map(id => memberActivities[id]).find(value => value !== undefined) ?? member.activity}</p>}
          </DeviceCard></div>;
        })}
        <div className="classroom-desk desk-media">
          <button className="object-button" type="button" onClick={createBoard} aria-label="画板"  aria-pressed={!!activeBoard}><ClassroomProp name="chalk-cup" /></button>
          <button className="object-button calendar-entry-button" type="button" aria-label="双人日历" ><ClassroomProp name="calendar-entry" /></button>
          <RoomCollaboration key={identityId} identityId={identityId} entryReady={entryReady} onChanged={loadTasks} onNotice={playNotificationSound} onPublicTasks={setPublicTasks} triggerContent={<ClassroomProp name="taskboard" />} />

        </div>
        <div className="classroom-desk desk-room">
          <button className="object-button cloud-entry-button" type="button" onClick={openCloud} aria-label="云盘" ><ClassroomProp name="folder" /></button>
          <ClassroomSettings profile={classroomProfile.profile} identityId={identityId} onSave={classroomProfile.save} error={classroomProfile.error} triggerContent={<ClassroomProp name="settings" />} notifications={<>
            <button type="button" disabled={pushBusy || pushTesting || pushStatus === "checking" || pushStatus === "unsupported"} onClick={() => {
              if (pushStatus === "unknown") { setPushStatus("checking"); setPushCheckVersion(version => version + 1); }
              else void (pushStatus === "enabled" ? disablePushNotifications() : enablePushNotifications());
            }}>{pushBusy ? "处理中…" : pushStatus === "checking" ? "检查提醒状态…" : pushStatus === "unknown" ? "重新检查提醒" : pushStatus === "unsupported" ? "当前环境不支持提醒" : pushStatus === "enabled" ? "关闭此设备提醒" : pushStatus === "renewal" ? "重新开启此设备提醒" : "开启此设备提醒"}</button>
            <button type="button" disabled={pushBusy || pushTesting || pushStatus !== "enabled"} onClick={() => void testPushNotifications()}>{pushTesting ? "测试中…" : "发送测试提醒"}</button>
            {(pushMessage || pushTestMessage) && <p role="status">{pushTestMessage || pushMessage}</p>}
          </>} />
        </div>
      </div>

      <EmergencyExit onClick={() => { intentionalLeaveRef.current = true; stopShare(); stopCamera(); stopMicrophone(); window.location.assign("/access"); }} />
      <RemoteRoomAudio sources={[
        ...Object.entries(remoteMicrophones).filter(([peer]) => peerIdentityIds[peer] !== identityId).map(([peer, media]) => ({ id: `microphone:${peer}`, stream: media })),
        ...Object.entries(remoteScreens).filter(([peer]) => peerIdentityIds[peer] !== identityId).map(([peer, media]) => ({ id: `screen:${peer}`, stream: media, muted: remoteScreenMuted })),
      ]} />
      {microphoneError && <p className="room-microphone-error" role="alert">{microphoneError}</p>}
      <RoomBell triggerHost={bellHost} onShowChat={showBellChat} onNotice={playNotificationSound} entryReady={entryReady} />
      {profileReady && !joined && <p className="error-message" role="alert">{joinError || "正在进入自习室…"}</p>}

      {cloudOpen && <CloudDrive onClose={() => setCloudOpen(false)} onImage={openChatImage} />}

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
    {!entryReady && <RoomLoadingScreen overlay displayName={displayName} error={entryError} onRetry={() => window.location.reload()} />}
    </>
  );
}
