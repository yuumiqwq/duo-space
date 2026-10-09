export type RoomParticipant = {
  peerId: string;
  deviceId: string;
  name: string;
  identityId: string;
  expiresAt: number;
};

type Options = {
  deviceId: string;
  mobile: boolean;
  peerId: () => string;
  name: () => string;
  changed: (participants: RoomParticipant[]) => void;
  request?: typeof fetch;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

function normalizeParticipants(value: unknown, now: number): RoomParticipant[] {
  if (!Array.isArray(value)) throw new Error('Invalid room presence');
  const byDevice = new Map<string, RoomParticipant>();
  for (const participant of value) {
    if (!participant || typeof participant.peerId !== 'string'
      || (participant.peerId !== '' && !/^[A-Za-z0-9_-]{1,64}$/.test(participant.peerId))
      || typeof participant.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(participant.deviceId)
      || typeof participant.name !== 'string' || typeof participant.identityId !== 'string') continue;
    // Older servers omit the lease deadline. Keep those snapshots for one
    // desktop lease until the next heartbeat provides a current snapshot.
    const expiresAt = Number.isFinite(participant.expiresAt) ? participant.expiresAt : now + 60_000;
    if (expiresAt < now) continue;
    byDevice.set(participant.deviceId, {
      peerId: participant.peerId, deviceId: participant.deviceId,
      name: participant.name.trim().slice(0, 24) || '成员', identityId: participant.identityId.trim().slice(0, 64), expiresAt,
    });
  }
  return [...byDevice.values()];
}

// The server lease is independent from PeerJS signalling and data channels.
// Every caller shares one in-flight request; normal polls accept its response.
export function createRoomPresence(options: Options) {
  const request = options.request || fetch, now = options.now || Date.now;
  const setTimer = options.setTimer || ((callback: () => void, delay: number) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer || ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let disposed = false;
  let participants: RoomParticipant[] = [];
  let expirationTimer: unknown;
  let generation = 0;
  let active: { controller: AbortController; promise: Promise<RoomParticipant[]>; timeout: unknown; background: boolean; peerId: string } | undefined;
  let queuedBackground: boolean | undefined;

  const publish = (next: RoomParticipant[]) => {
    participants = next;
    if (expirationTimer !== undefined) clearTimer(expirationTimer);
    expirationTimer = undefined;
    if (!disposed && next.length) expirationTimer = setTimer(prune, Math.max(1, Math.min(...next.map(item => item.expiresAt)) - now() + 1));
    options.changed(next);
  };
  const prune = () => {
    if (disposed) return;
    const next = participants.filter(item => item.expiresAt >= now());
    if (next.length !== participants.length) publish(next);
  };
  const sync = (background = false, restart = false): Promise<RoomParticipant[]> => {
    if (disposed) return Promise.resolve([]);
    prune();
    if (active && !restart) {
      if (active.background !== background || active.peerId !== options.peerId()) queuedBackground = background;
      return active.promise;
    }
    if (active) { active.controller.abort(); clearTimer(active.timeout); }
    queuedBackground = undefined;
    const version = ++generation, controller = new AbortController(), peerId = options.peerId();
    const timeout = setTimer(() => controller.abort(), 10_000);
    const operation = Promise.resolve().then(async () => {
      try {
        if (disposed || controller.signal.aborted || version !== generation) return participants;
        const response = await request('/api/room/presence', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ peerId, deviceId: options.deviceId, name: options.name(), mobile: options.mobile, background }),
          cache: 'no-store', keepalive: background, signal: controller.signal,
        });
        if (!response.ok || response.redirected) throw new Error('Room presence unavailable');
        const data = await response.json() as { participants?: unknown };
        if (disposed || controller.signal.aborted || version !== generation) return participants;
        publish(normalizeParticipants(data.participants, now()));
      } catch { prune(); }
      finally {
        clearTimer(timeout);
        if (version === generation) {
          active = undefined;
          if (!disposed && queuedBackground !== undefined) {
            const queued = queuedBackground; queuedBackground = undefined;
            void sync(queued);
          }
        }
      }
      return participants;
    });
    active = { controller, promise: operation, timeout, background, peerId };
    return operation;
  };
  return {
    sync,
    close(leave: boolean) {
      if (disposed) return;
      disposed = true; generation++;
      active?.controller.abort();
      if (active) clearTimer(active.timeout);
      if (expirationTimer !== undefined) clearTimer(expirationTimer);
      if (leave) void Promise.resolve().then(() => request('/api/room/presence', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: options.deviceId }), keepalive: true,
      })).catch(() => undefined);
    },
  };
}
