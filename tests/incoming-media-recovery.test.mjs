import test from 'node:test';
import assert from 'node:assert/strict';
import { createIncomingMediaRecovery } from '../app/incoming-media-recovery.ts';

function setup() {
  let time = 0;
  const open = new Set(['other-device']), sent = [], reconnects = [];
  const recovery = createIncomingMediaRecovery({
    now: () => time,
    send: (peer, source) => { if (!open.has(peer)) return false; sent.push({ peer, source }); return true; },
    reconnect: peer => reconnects.push(peer),
  });
  return { recovery, open, sent, reconnects, advance: n => { time += n; } };
}
test('camera repair waits for its own device, not another online device', () => {
  const s = setup();
  s.recovery.request('camera-device', 'camera');
  assert.deepEqual(s.sent, []);
  assert.deepEqual(s.reconnects, ['camera-device']);
  // The failed media call has been removed; the pending request survives.
  s.recovery.flush();
  s.open.add('camera-device'); s.recovery.flush(); s.recovery.flush();
  assert.deepEqual(s.sent, [{ peer: 'camera-device', source: 'camera' }]);
});
test('multiple sources survive signaling downtime and duplicate repair requests coalesce', () => {
  const s = setup();
  s.recovery.request('publisher', 'screen'); s.recovery.request('publisher', 'camera');
  s.recovery.request('publisher', 'screen');
  s.open.add('publisher'); s.recovery.flush();
  assert.deepEqual(s.sent, [{ peer: 'publisher', source: 'screen' }, { peer: 'publisher', source: 'camera' }]);
});
test('departed or expired publishers cannot receive stale queued repairs', () => {
  const s = setup();
  s.recovery.request('left', 'camera'); s.recovery.request('expired', 'screen');
  s.recovery.forget('left'); s.advance(120_000);
  s.open.add('left'); s.open.add('expired'); s.recovery.flush();
  assert.deepEqual(s.sent, []);
});
