import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaRecovery, mediaCallReusable, mediaNeedsRepair } from '../app/media-recovery.ts';

test('static screens do not reconnect periodically; failed transport and stalled decoding still recover', () => {
  assert.equal(mediaNeedsRepair('screen', 'connected', true, 120, 0), false);
  assert.equal(mediaNeedsRepair('screen', 'connected', true, 120, 20), true);
  assert.equal(mediaNeedsRepair('screen', 'connected', true, 0, 0), true);
  assert.equal(mediaNeedsRepair('screen', 'disconnected', true, 120, 0), true);
  assert.equal(mediaNeedsRepair('screen', 'failed', false, 120, 0), true);
  assert.equal(mediaNeedsRepair('camera', 'connected', true, 120, 0), true);
  assert.equal(mediaNeedsRepair('microphone', 'connected', true, 120, 0), true);
  assert.equal(mediaNeedsRepair('screen', 'connected', false, 120, 20), false);
});

function setup() {
  let time = 20_000;
  let online = true;
  const track = { readyState: 'live', muted: false };
  const screen = { getVideoTracks: () => [track] };
  const streams = { screen, camera: null };
  const sent = [];
  const recovery = createMediaRecovery({
    peers: () => ['viewer-a', 'viewer-b'], canSend: () => online,
    stream: source => streams[source], now: () => time,
    restart: (peer, stream, source) => sent.push({ peer, stream, source }),
  });
  return { recovery, sent, track, streams, screen, setOnline: value => { online = value; }, advance: ms => { time += ms; } };
}

test('publisher recovery resends its existing capture to every viewer, without requesting capture permission', () => {
  const s = setup();
  s.recovery.request('screen');
  assert.deepEqual(s.sent.map(x => x.peer), ['viewer-a', 'viewer-b']);
  assert.ok(s.sent.every(x => x.stream === s.screen && x.source === 'screen'));
  s.recovery.request('camera');
  assert.equal(s.sent.length, 2);
});

test('visibility recovery waits for both signaling and OS capture unmute', () => {
  const s = setup();
  s.setOnline(false); s.track.muted = true;
  s.recovery.request('screen');
  s.setOnline(true); s.recovery.flush();
  assert.equal(s.sent.length, 0);
  s.track.muted = false; s.recovery.flush();
  assert.equal(s.sent.length, 2);
  s.recovery.flush();
  assert.equal(s.sent.length, 2);
});

test('concurrent receiver repair and foreground events are coalesced, but not lost during cooldown', () => {
  const s = setup();
  s.recovery.request('screen', 'viewer-a');
  s.advance(1000);
  s.recovery.request('screen', 'viewer-a');
  s.recovery.request('screen', 'viewer-a');
  assert.equal(s.sent.length, 1);
  s.advance(9000); s.recovery.flush();
  assert.equal(s.sent.length, 2);
});

test('stopped capture and departed viewers are never resurrected by pending recovery', () => {
  const s = setup();
  s.setOnline(false); s.recovery.request('screen');
  s.recovery.forget('viewer-a');
  s.track.readyState = 'ended';
  s.setOnline(true); s.recovery.flush();
  s.track.readyState = 'live'; s.recovery.flush();
  assert.equal(s.sent.length, 0);
});

test('reconciliation preserves pending offers and replaces failed or closed media calls', () => {
  for (const connectionState of ['new', 'connecting', 'connected', 'disconnected']) {
    assert.equal(mediaCallReusable({ peerConnection: { connectionState } }), true);
  }
  for (const connectionState of ['failed', 'closed']) {
    assert.equal(mediaCallReusable({ peerConnection: { connectionState } }), false);
  }
  assert.equal(mediaCallReusable(undefined), false);
});
