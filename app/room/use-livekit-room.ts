"use client";

import { Room,RoomEvent,Track } from "livekit-client";
import type { Dispatch,RefObject,SetStateAction } from "react";
import { useEffect } from "react";
import { RoomBoard } from "../Whiteboard";
import { type MediaSource } from "../media-recovery";
import { ChatMessage,mergeChatMessages,normalizeIncomingMessage,OutgoingChat,SharedTask,USE_LIVEKIT } from './model';

type Options = {
  joined: boolean;
  roomRef: RefObject<Room | null>;
  setRoomMembers: Dispatch<SetStateAction<string[]>>;
  setMemberNames: Dispatch<SetStateAction<Record<string, string>>>;
  setPeerIdentityIds: Dispatch<SetStateAction<Record<string, string>>>;
  setRemoteMicrophones: Dispatch<SetStateAction<Record<string, MediaStream>>>;
  setRemoteCameras: Dispatch<SetStateAction<Record<string, MediaStream>>>;
  setRemoteScreens: Dispatch<SetStateAction<Record<string, MediaStream>>>;
  activityRef: RefObject<string>;
  broadcastRoomMessage: (message: object) => void;
  boardsRef: RefObject<RoomBoard[]>;
  deletedBoardIdsRef: RefObject<Set<string>>;
  setMemberTasks: Dispatch<SetStateAction<Record<string, SharedTask[]>>>;
  setMemberActivities: Dispatch<SetStateAction<Record<string, string>>>;
  receiveBoardMessage: (message: { type?: string; boards?: unknown; deletedBoardIds?: unknown; board?: unknown; id?: unknown; boardId?: unknown; stroke?: unknown; strokeId?: unknown; text?: unknown; textId?: unknown; epoch?: unknown; }) => boolean;
  recalledChatIdsRef: RefObject<Set<string>>;
  outgoingChatRef: RefObject<Map<string, OutgoingChat>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  identityIdRef: RefObject<string>;
  playNotificationSound: (messageId: string) => void;
  setRoomError: Dispatch<SetStateAction<string>>;
  displayName: string;
};

export function useLiveKitRoom({ joined, roomRef, setRoomMembers, setMemberNames, setPeerIdentityIds, setRemoteMicrophones, setRemoteCameras, setRemoteScreens, activityRef, broadcastRoomMessage, boardsRef, deletedBoardIdsRef, setMemberTasks, setMemberActivities, receiveBoardMessage, recalledChatIdsRef, outgoingChatRef, setMessages, identityIdRef, playNotificationSound, setRoomError, displayName }: Options) {



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
          recalledChatIdsRef.current.add(message.id);
          outgoingChatRef.current.delete(message.id);
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
        if (!normalized || recalledChatIdsRef.current.has(normalized.id)) return;
        const incomingMessage: ChatMessage = { ...normalized, sender: participant?.name?.trim() || normalized.sender || participant?.identity || "成员" };
        if (incomingMessage.own) outgoingChatRef.current.delete(incomingMessage.id);
        else playNotificationSound(incomingMessage.id);
        setMessages((current) => mergeChatMessages([incomingMessage], current, recalledChatIdsRef.current));
      } catch { /* ignore invalid room messages */ }
    });
    room.on(RoomEvent.Disconnected, () => {
      if (!disposed) { setRoomError("实时房间连接已断开，请刷新后重试。"); }
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
        setRoomError("");
        refreshMembers();
      } catch {
        if (!disposed) { setRoomError("实时服务尚未完成配置，请稍后刷新重试。"); }
      }
    };
    void connect();
    return () => { disposed = true; room.disconnect(); roomRef.current = null; };
  }, [displayName, joined, playNotificationSound, receiveBoardMessage, broadcastRoomMessage, activityRef, boardsRef, deletedBoardIdsRef, identityIdRef, outgoingChatRef, recalledChatIdsRef, roomRef, setMemberActivities, setMemberNames, setMemberTasks, setMessages, setPeerIdentityIds, setRemoteCameras, setRemoteMicrophones, setRemoteScreens, setRoomError, setRoomMembers]);
}
