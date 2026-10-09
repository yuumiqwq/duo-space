import type { Ring } from './api/room/rings/store';

// A server record confirms the original operation even after its HTTP reply
// was lost. Future explicit sends must not reuse an ended operation's id.
export function reconcilePendingRings(pending: Record<string, string>, rings: Ring[]) {
  const confirmed = new Set(rings.map(ring => ring.id));
  for (const [recipient, id] of Object.entries(pending)) if (confirmed.has(id)) delete pending[recipient];
}
