export type MediaSource = "camera" | "screen" | "microphone";

export function mediaNeedsRepair(source: MediaSource, connectionState: string, stalled: boolean, frames: number, packetsSinceFrame: number) {
  if (["failed", "closed"].includes(connectionState)) return true;
  if (!stalled) return false;
  // A connected screen can legitimately stop producing frames while static.
  // Recover if it has never decoded, is disconnected, or receives video packets
  // without decoding them. Silence alone cannot distinguish static from frozen.
  return source !== "screen" || connectionState !== "connected" || frames <= 0 || packetsSinceFrame > 0;
}

// Keep recovery requests until signaling and capture are usable again. A page
// can become visible before PeerJS reconnects or the OS unmutes screen capture.
export function createMediaRecovery(options: {
  peers: () => string[];
  canSend: (peerId: string) => boolean;
  stream: (source: MediaSource) => MediaStream | null;
  restart: (peerId: string, stream: MediaStream, source: MediaSource) => void;
  now?: () => number;
}) {
  const pending = new Map<string, { peerId: string; source: MediaSource }>();
  const restartedAt = new Map<string, number>();
  const now = options.now || Date.now;
  const flush = () => {
    pending.forEach(({ peerId, source }, key) => {
      const stream = options.stream(source);
      const track = source === 'microphone' ? stream?.getAudioTracks()[0] : stream?.getVideoTracks()[0];
      if (!stream || !track || track.readyState !== "live") { pending.delete(key); return; }
      if (track.muted || !options.canSend(peerId)) return;
      const previous = restartedAt.get(key);
      if (previous !== undefined && now() - previous < 10_000) return;
      options.restart(peerId, stream, source);
      restartedAt.set(key, now());
      pending.delete(key);
    });
  };
  return {
    flush,
    request(source: MediaSource, peerId?: string) {
      for (const id of peerId === undefined ? options.peers() : [peerId]) {
        pending.set(`${source}:${id}`, { peerId: id, source });
      }
      flush();
    },
    forget(peerId: string) {
      for (const source of ["camera", "screen", "microphone"]) {
        pending.delete(`${source}:${peerId}`);
        restartedAt.delete(`${source}:${peerId}`);
      }
    },
  };
}

export function mediaCallReusable(call: { peerConnection?: { connectionState: string } } | undefined) {
  // Pending calls are reused too: periodic reconciliation must not cancel an
  // offer that is still waiting for the other page to wake up and answer.
  return Boolean(call && !["failed", "closed"].includes(call.peerConnection?.connectionState || "new"));
}
