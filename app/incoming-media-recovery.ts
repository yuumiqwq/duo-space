import type { MediaSource } from './media-recovery.ts';

// A media call can outlive its data channel. Keep the repair addressed to the
// publishing device until that device's signaling channel is usable again.
export function createIncomingMediaRecovery(options: {
  send: (peer: string, source: MediaSource) => boolean;
  reconnect: (peer: string) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const pending = new Map<string, { peer: string; source: MediaSource; expires: number }>();
  const flush = () => {
    const reconnect = new Set<string>();
    for (const [key, item] of pending) {
      if (now() >= item.expires || options.send(item.peer, item.source)) pending.delete(key);
      else reconnect.add(item.peer);
    }
    reconnect.forEach(options.reconnect);
  };
  return {
    flush,
    request(peer: string, source: MediaSource) {
      const key = `${source}:${peer}`;
      if (!pending.has(key)) pending.set(key, { peer, source, expires: now() + 120_000 });
      flush();
    },
    forget(peer: string) {
      for (const [key, item] of pending) if (item.peer === peer) pending.delete(key);
    },
  };
}
