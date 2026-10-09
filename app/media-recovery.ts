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
  version?: (peerId: string, source: MediaSource) => unknown;
  restart: (peerId: string, stream: MediaStream, source: MediaSource) => void;
  now?: () => number;
}) {
  const pending = new Map<string, { peerId: string; source: MediaSource; stream: MediaStream | null; version: unknown }>();
  const restartedAt = new Map<string, number>();
  const now = options.now || Date.now;
  const flush = () => {
    pending.forEach(({ peerId, source, stream: requestedStream, version }, key) => {
      const stream = options.stream(source);
      if (stream !== requestedStream || options.version?.(peerId, source) !== version) { pending.delete(key); return; }
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
        pending.set(`${source}:${id}`, { peerId: id, source, stream: options.stream(source), version: options.version?.(id, source) });
      }
      flush();
    },
    cancel(source: MediaSource, peerId: string) { pending.delete(`${source}:${peerId}`); },
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

// Allow delayed offer/answer and ICE progress without repeatedly cancelling an
// otherwise viable call. Inactivity and total negotiation time remain bounded.
export function watchMediaNegotiation(pc: RTCPeerConnection | undefined, failed: () => void, connected: () => void = () => {}) {
  let disposed = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const events = ['connectionstatechange', 'iceconnectionstatechange', 'icegatheringstatechange', 'signalingstatechange'] as const;
  const dispose = () => {
    disposed = true;
    clearTimeout(idleTimer); clearTimeout(totalTimer);
    events.forEach(event => pc?.removeEventListener(event, progress));
  };
  const fail = () => { if (!disposed) { dispose(); failed(); } };
  const progress = () => {
    if (disposed) return;
    if (pc?.connectionState === 'connected') { dispose(); connected(); return; }
    if (pc && ['failed', 'closed'].includes(pc.connectionState)) { fail(); return; }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(fail, 45_000);
  };
  events.forEach(event => pc?.addEventListener(event, progress));
  const totalTimer = setTimeout(fail, 120_000);
  progress();
  return dispose;
}
