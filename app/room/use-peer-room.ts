"use client";

import type { DataConnection,MediaConnection,Peer as PeerClient,PeerOptions } from "peerjs";
import type { Dispatch,RefObject,SetStateAction } from "react";
import { useEffect } from "react";
import type { RoomParticipant } from './room-presence';
import { RoomBoard } from "../Whiteboard";
import { createIncomingMediaRecovery } from '../incoming-media-recovery';
import { onMediaForeground } from '../media-foreground';
import { createMediaRecovery,mediaCallReusable,mediaNeedsRepair,watchMediaNegotiation,type MediaSource } from "../media-recovery";
import { watchRemoteMediaTracks,whenRemoteMediaReady } from '../media-tracks';
import { encodeRoomPackets } from "../room-packets";
import { ChatMessage,isMobileBrowser,MAX_REMOTE_DEVICES,mergeChatMessages,MOBILE_BACKGROUND_GRACE_MS,normalizeIncomingMessage,OutgoingChat,SharedTask,Task,USE_LIVEKIT } from './model';

type Options = {
  joined: boolean;
  dataConnectionsRef: RefObject<Map<string, DataConnection>>;
  outgoingCallsRef: RefObject<Map<string, MediaConnection>>;
  incomingCallsRef: RefObject<Map<string, MediaConnection>>;
  microphoneStreamRef: RefObject<MediaStream | null>;
  screenStreamRef: RefObject<MediaStream | null>;
  cameraStreamRef: RefObject<MediaStream | null>;
  recoverPublishedMediaRef: RefObject<(source: MediaSource) => void>;
  setRoomError: Dispatch<SetStateAction<string>>;
  hostPeerIdRef: RefObject<string>;
  displayNameRef: RefObject<string>;
  setMemberNames: Dispatch<SetStateAction<Record<string, string>>>;
  setPeerIdentityIds: Dispatch<SetStateAction<Record<string, string>>>;
  setRoomMembers: Dispatch<SetStateAction<string[]>>;
  setRemoteMicrophones: Dispatch<SetStateAction<Record<string, MediaStream>>>;
  setRemoteCameras: Dispatch<SetStateAction<Record<string, MediaStream>>>;
  setRemoteScreens: Dispatch<SetStateAction<Record<string, MediaStream>>>;
  setMemberTasks: Dispatch<SetStateAction<Record<string, SharedTask[]>>>;
  setMemberActivities: Dispatch<SetStateAction<Record<string, string>>>;
  identityIdRef: RefObject<string>;
  callPeerRef: RefObject<(peerId: string, media: MediaStream, source: MediaSource) => void>;
  selfPeerIdRef: RefObject<string>;
  activityRef: RefObject<string>;
  tasksRef: RefObject<Task[]>;
  boardsRef: RefObject<RoomBoard[]>;
  deletedBoardIdsRef: RefObject<Set<string>>;
  receiveBoardMessage: (message: { type?: string; boards?: unknown; deletedBoardIds?: unknown; board?: unknown; id?: unknown; boardId?: unknown; stroke?: unknown; strokeId?: unknown; text?: unknown; textId?: unknown; epoch?: unknown; }) => boolean;
  recalledChatIdsRef: RefObject<Set<string>>;
  outgoingChatRef: RefObject<Map<string, OutgoingChat>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  memberNamesRef: RefObject<Record<string, string>>;
  playNotificationSound: (messageId: string) => void;
  setActiveMediaId: Dispatch<SetStateAction<string>>;
  peerRef: RefObject<PeerClient | null>;
  presenceDeviceIdRef: RefObject<string>;
  syncPresence: (background?: boolean) => Promise<RoomParticipant[]>;
};

export function usePeerRoom({ joined, dataConnectionsRef, outgoingCallsRef, incomingCallsRef, microphoneStreamRef, screenStreamRef, cameraStreamRef, recoverPublishedMediaRef, setRoomError, hostPeerIdRef, displayNameRef, setMemberNames, setPeerIdentityIds, setRoomMembers, setRemoteMicrophones, setRemoteCameras, setRemoteScreens, setMemberTasks, setMemberActivities, identityIdRef, callPeerRef, selfPeerIdRef, activityRef, tasksRef, boardsRef, deletedBoardIdsRef, receiveBoardMessage, recalledChatIdsRef, outgoingChatRef, setMessages, memberNamesRef, playNotificationSound, setActiveMediaId, peerRef, presenceDeviceIdRef, syncPresence }: Options) {


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
    const mediaProgress = new Map<MediaConnection, { frames: number; packetsAtFrame: number; changedAt: number; checking: boolean }>();
    const mediaRecovery = createMediaRecovery({
      peers: () => Array.from(connections.keys()),
      canSend: (peerId) => !disposed && Boolean(localPeer?.open && connections.get(peerId)?.open),
      stream: (source) => source === "microphone" ? microphoneStreamRef.current : source === "screen" ? screenStreamRef.current : cameraStreamRef.current,
      version: (peerId, source) => outgoingCalls.get(`${source}:${peerId}`),
      restart: (peerId, media, source) => callPeer(peerId, media, source, 0, true),
    });
    const incomingRecovery = createIncomingMediaRecovery({
      send: (peerId, source, callId) => {
        const connection = connections.get(peerId);
        if (disposed || !connection?.open) return false;
        try { connection.send({ type: 'media-request', repair: true, source, callId }); return true; }
        catch { return false; }
      },
      reconnect: peerId => { if (!disposed) connectToPeer(peerId); },
    });
    recoverPublishedMediaRef.current = (source) => {
      const media = source === "microphone" ? microphoneStreamRef.current : source === "screen" ? screenStreamRef.current : cameraStreamRef.current;
      if (media) connections.forEach(connection => callPeer(connection.peer, media, source));
    };
    const connectionTimers = new Set<number>();
    let reconnectStartedAt = 0;
    let localDeviceId = "";
    let reconnectTimer: number | null = null;
    let recoveryMessageTimer: number | null = null;
    let mediaHeartbeatTimer: number | null = null;
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
      if (disposed) return;
      try {
        const participants = await syncPresence(background);
        const peer = localPeer;
        if (disposed || !peer?.open || !peer.id || !localDeviceId) return;
        const discovered = participants.filter(item => item.peerId && item.peerId !== peer.id && item.deviceId !== localDeviceId);
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

    const startMediaHeartbeat = () => {
      if (mediaHeartbeatTimer !== null) window.clearInterval(mediaHeartbeatTimer);
      void syncRoomPresence();
      mediaHeartbeatTimer = window.setInterval(() => {
        // Presence also polls independently; discovery here precedes sends that
        // can fail on a closing data channel.
        void syncRoomPresence();
        recoverRoomConnection();
        mediaRecovery.flush();
        incomingRecovery.flush();
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
          const progress = mediaProgress.get(call) || { frames: -1, packetsAtFrame: 0, changedAt: Date.now(), checking: false };
          mediaProgress.set(call, progress);
          if (progress.checking || !call.peerConnection) return;
          progress.checking = true;
          void call.peerConnection.getStats().then((stats) => {
            if (disposed || incomingCalls.get(key) !== call) return;
            let frames = 0, packets = 0;
            stats.forEach((report) => {
              const kind = report.kind || report.mediaType;
              if (report.type !== 'inbound-rtp') return;
              if (key.startsWith('microphone:') && kind === 'audio') frames += report.packetsReceived || 0;
              else if (kind === 'video') { frames += report.framesDecoded || 0; packets += report.packetsReceived || 0; }
            });
            const failed = ["failed", "closed"].includes(call.peerConnection.connectionState);
            const source = key.startsWith('microphone:') ? 'microphone' : key.startsWith('screen:') ? 'screen' : 'camera';
            if (frames > progress.frames) {
              progress.frames = frames; progress.packetsAtFrame = packets; progress.changedAt = Date.now();
              if (frames > 0) {
                incomingRecovery.cancel(call.peer, source);
                const connection = connections.get(call.peer);
                if (connection?.open) connection.send({ type: 'media-request', healthy: true, source, callId: call.connectionId });
              }
            }
            if (mediaNeedsRepair(source, call.peerConnection.connectionState, Date.now() - progress.changedAt > 20_000, frames, packets - progress.packetsAtFrame)) {
              progress.changedAt = Date.now();
              incomingRecovery.request(call.peer, source, call.connectionId);
              if (failed && incomingCalls.get(key) === call) {
                incomingCalls.delete(key);
                mediaProgress.delete(call);
                removeRemoteMedia(call.peer, source);
                call.close();
              }
            }
          }).catch(() => undefined).finally(() => { progress.checking = false; });
        });
      }, 5000);
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
      incomingRecovery.forget(peerId);
      const removalTimer = peerRemovalTimers.get(peerId);
      if (removalTimer !== undefined) window.clearTimeout(removalTimer);
      peerRemovalTimers.delete(peerId);
      connections.delete(peerId);
      peerDeviceIds.delete(peerId);
      mobilePeerIds.delete(peerId);
      pendingPeerIds.delete(peerId);
      closePeerCalls(peerId);
      setRoomError("");
      window.setTimeout(() => {
        if (!disposed && localPeer?.open && connections.size === 0) {
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

    const callPeer = (peerId: string, media: MediaStream, source: MediaSource, attempt = 0, repair = false) => {
      if (disposed || !localPeer?.open || !connections.get(peerId)?.open) return;
      const key = `${source}:${peerId}`;
      const existing = outgoingCalls.get(key);
      if (!(source === "microphone" ? media.getAudioTracks() : media.getVideoTracks()).some((track) => track.readyState === "live")) return;
      if (mediaCallReusable(existing) && (!repair || !existing?.open || ['new', 'connecting'].includes(existing.peerConnection?.connectionState || 'new'))) return;

      const call = localPeer.call(peerId, media, { metadata: { source, name: displayNameRef.current, identityId: identityIdRef.current } });
      outgoingCalls.set(key, call);
      let stopWatching = () => {};
      const retry = () => {
        if (disposed || outgoingCalls.get(key) !== call) return;
        outgoingCalls.delete(key);
        call.close();
        const currentStream = source === "microphone" ? microphoneStreamRef.current : source === "camera" ? cameraStreamRef.current : screenStreamRef.current;
        if (!currentStream || currentStream !== media || attempt >= 3) return;
        window.setTimeout(() => {
          const latestStream = source === "microphone" ? microphoneStreamRef.current : source === "camera" ? cameraStreamRef.current : screenStreamRef.current;
          if (!disposed && latestStream === currentStream) callPeer(peerId, currentStream, source, attempt + 1);
        }, 900 * (attempt + 1));
      };
      call.on("close", () => {
        stopWatching();
        existing?.close();
        if (outgoingCalls.get(key) === call) outgoingCalls.delete(key);
      });
      call.on("error", retry);
      stopWatching = watchMediaNegotiation(call.peerConnection, retry, () => {
        if (outgoingCalls.get(key) !== call) return;
        existing?.close();
        mediaRecovery.cancel(source, peerId);
      });
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
          recalledChatIdsRef.current.add(message.id);
          outgoingChatRef.current.delete(message.id);
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
          const request = payload as { repair?: boolean; healthy?: boolean; source?: string; callId?: string };
          if (request.healthy === true && (request.source === "screen" || request.source === "camera" || request.source === "microphone")) {
            if (outgoingCalls.get(`${request.source}:${peerId}`)?.connectionId === request.callId) mediaRecovery.cancel(request.source, peerId);
            return;
          }
          if (request.repair === true && (request.source === "screen" || request.source === "camera" || request.source === "microphone")) {
            const current = outgoingCalls.get(`${request.source}:${peerId}`);
            if (request.callId && current && current.connectionId !== request.callId) return;
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
          if (!normalized || recalledChatIdsRef.current.has(normalized.id)) return;
          const incomingMessage: ChatMessage = {
            ...normalized,
            sender: normalized.sender || memberNamesRef.current[peerId] || "成员",
          };
          if (incomingMessage.own) outgoingChatRef.current.delete(incomingMessage.id);
          else playNotificationSound(incomingMessage.id);
          setMessages((current) => mergeChatMessages([incomingMessage], current, recalledChatIdsRef.current));
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

        localDeviceId = presenceDeviceIdRef.current;

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
          if (previous) mediaProgress.delete(previous);
          let stopTracking = () => {};
          let stopPreparing = () => {};
          call.on("stream", (remoteStream) => {
            if (disposed || incomingCalls.get(key) !== call) return;
            const setter = source === "microphone" ? setRemoteMicrophones : source === "camera" ? setRemoteCameras : setRemoteScreens;
            stopTracking();
            stopTracking = watchRemoteMediaTracks(remoteStream, source, () => {
              if (incomingCalls.get(key) === call) removeRemoteMedia(peerId, source);
            });
            stopPreparing();
            stopPreparing = whenRemoteMediaReady(remoteStream, source, () => {
              if (disposed || incomingCalls.get(key) !== call) return;
              setter((current) => ({ ...current, [peerId]: remoteStream }));
              setRoomError("");
              if (source === "screen") setActiveMediaId(`${peerId}-screen`);
              incomingRecovery.cancel(peerId, source);
              previous?.close();
            });
          });
          call.on("close", () => {
            stopTracking();
            stopPreparing();
            previous?.close();
            mediaProgress.delete(call);
            if (incomingCalls.get(key) !== call) return;
            incomingCalls.delete(key);
            removeRemoteMedia(peerId, source);
          });
          call.on("error", () => {
            stopTracking();
            stopPreparing();
            mediaProgress.delete(call);
            if (incomingCalls.get(key) !== call) return;
            incomingCalls.delete(key);
            removeRemoteMedia(peerId, source);
            call.close();
            incomingRecovery.request(peerId, source, call.connectionId);
          });
          call.answer();
          // Incoming media does not guarantee a matching data channel exists.
          if (!connections.get(peerId)?.open) connectToPeer(peerId);
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
            setRoomError("");
            startMediaHeartbeat();
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
            setRoomError("实时房间连接失败，请检查代理网络后刷新页面。");
          });
        };

        attachPeer(new Peer(peerOptions));
      } catch {
        setRoomError("实时房间组件加载失败，请刷新页面重试。");
      } finally {
        initializingRoom = false;
      }
    };

    const resumeMedia = () => {
      // Reconcile all sources without tearing down an established capture.
      // Failed calls and stalled decoding are repaired by the receiver checks.
      connections.forEach((connection) => {
        if (!connection.open) return;
        connection.send({ type: "media-request" });
        if (screenStreamRef.current) callPeer(connection.peer, screenStreamRef.current, "screen");
        if (cameraStreamRef.current) callPeer(connection.peer, cameraStreamRef.current, "camera");
        if (microphoneStreamRef.current) callPeer(connection.peer, microphoneStreamRef.current, "microphone");
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        void syncRoomPresence(true);
        return;
      }
      clearReconnectTimer();
      recoverRoomConnection();
      void syncRoomPresence();
    };
    const recoverWhenActive = () => {
      clearReconnectTimer();
      recoverRoomConnection();
      void syncRoomPresence();
    };
    const stopForegroundRecovery = onMediaForeground(document, window, resumeMedia);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", recoverWhenActive);
    window.addEventListener("online", recoverWhenActive);
    window.addEventListener("pageshow", recoverWhenActive);
    void initializeRoom();

    return () => {
      disposed = true;
      clearReconnectTimer();
      clearRecoveryMessageTimer();
      if (mediaHeartbeatTimer !== null) window.clearInterval(mediaHeartbeatTimer);
      stopForegroundRecovery();
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
      selfPeerIdRef.current = "";
    };
  }, [joined, playNotificationSound, receiveBoardMessage, activityRef, boardsRef, callPeerRef, cameraStreamRef, dataConnectionsRef, deletedBoardIdsRef, displayNameRef, hostPeerIdRef, identityIdRef, incomingCallsRef, memberNamesRef, microphoneStreamRef, outgoingCallsRef, outgoingChatRef, peerRef, presenceDeviceIdRef, recalledChatIdsRef, recoverPublishedMediaRef, screenStreamRef, selfPeerIdRef, setActiveMediaId, setMemberActivities, setMemberNames, setMemberTasks, setMessages, setPeerIdentityIds, setRemoteCameras, setRemoteMicrophones, setRemoteScreens, setRoomError, setRoomMembers, syncPresence, tasksRef]);
}
