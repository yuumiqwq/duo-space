import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createMediaRecovery, mediaCallReusable, watchMediaNegotiation } from '../app/media-recovery.ts';
import { watchRemoteMediaTracks, whenRemoteMediaReady } from '../app/media-tracks.ts';
import { createIncomingMediaRecovery } from '../app/incoming-media-recovery.ts';
import { attachVideoPlayback } from '../app/video-playback.ts';

const page = readFileSync('app/room/use-peer-room.ts', 'utf8').replaceAll('\r\n', '\n');
function extract(start, end, env, result) {
  const first = page.indexOf(start), last = page.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first);
  const js = ts.transpileModule(page.slice(first, last), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), js + '\nreturn ' + result)(...Object.values(env));
}
class Track extends EventTarget {
  constructor(kind) { super(); this.kind = kind; this.readyState = 'live'; this.muted = false; }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
}
class Stream extends EventTarget {
  constructor(...tracks) { super(); this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
}
class PC extends EventTarget {
  connectionState = 'new';
  state(value) { this.connectionState = value; this.dispatchEvent(new Event('connectionstatechange')); }
}
class Call extends EventEmitter {
  peerConnection = new PC(); open = false; closes = 0;
  constructor(id = crypto.randomUUID()) { super(); this.connectionId = id; this.peer = 'peer'; this.metadata = { source: 'screen' }; }
  answer() {}
  close() { if (this.closes++) return; this.peerConnection.state('closed'); this.emit('close'); }
}

test('production receiver keeps live video after audio ends and removes only the exhausted source', () => {
  let screens = {};
  const env = {
    disposed: false, incomingCalls: new Map(), mediaProgress: new Map(), connections: new Map(),
    rememberPeerName() {}, rememberPeerIdentity() {}, setRoomError() {}, setActiveMediaId() {}, connectToPeer() {},
    setRemoteScreens: update => { screens = update(screens); }, setRemoteMicrophones() {}, setRemoteCameras() {},
    removeRemoteMedia: peer => { delete screens[peer]; },
    incomingRecovery: { request() {}, cancel() {} }, watchRemoteMediaTracks, whenRemoteMediaReady,
  };
  const handleCall = extract('        const handleCall = (call:', '        const attachPeer', env, 'handleCall');
  const audio = new Track('audio'), first = new Track('video'), second = new Track('video');
  const stream = new Stream(audio, first, second), call = new Call();
  handleCall(call); call.emit('stream', stream);
  audio.end(); assert.equal(screens.peer, stream);
  first.end(); assert.equal(screens.peer, stream);
  second.end(); assert.equal(screens.peer, undefined);
  call.close();
});

test('track lifetime follows added/removed video tracks and ignores obsolete listeners', () => {
  const audio = new Track('audio'), video = new Track('video'), stream = new Stream(audio);
  let ended = 0;
  const stop = watchRemoteMediaTracks(stream, 'screen', () => ended++);
  audio.end(); assert.equal(ended, 0);
  stream.tracks.push(video); stream.dispatchEvent(new Event('addtrack'));
  const replacement = new Track('video'); stream.tracks.push(replacement); stream.dispatchEvent(new Event('addtrack'));
  stream.tracks = [replacement]; stream.dispatchEvent(new Event('removetrack'));
  video.end(); assert.equal(ended, 0);
  replacement.end(); assert.equal(ended, 1);
  stop(); stream.dispatchEvent(new Event('removetrack')); assert.equal(ended, 1);
  const microphone = new Track('audio');
  const stopMic = watchRemoteMediaTracks(new Stream(microphone, new Track('video')), 'microphone', () => ended++);
  microphone.end(); assert.equal(ended, 2); stopMic();
});

test('production receiver retains the old picture until replacement video unmutes and cannot resurrect cancelled preparation', () => {
  let screens = {};
  const env = {
    disposed: false, incomingCalls: new Map(), mediaProgress: new Map(), connections: new Map(),
    rememberPeerName() {}, rememberPeerIdentity() {}, setRoomError() {}, setActiveMediaId() {}, connectToPeer() {},
    setRemoteScreens: update => { screens = update(screens); }, setRemoteMicrophones() {}, setRemoteCameras() {},
    removeRemoteMedia: peer => { delete screens[peer]; },
    incomingRecovery: { request() {}, cancel() {} }, watchRemoteMediaTracks, whenRemoteMediaReady,
  };
  const handleCall = extract('        const handleCall = (call:', '        const attachPeer', env, 'handleCall');
  const old = new Call(), oldTrack = new Track('video'), oldStream = new Stream(oldTrack);
  handleCall(old); old.emit('stream', oldStream);
  const next = new Call(), nextTrack = new Track('video'), nextStream = new Stream(nextTrack); nextTrack.muted = true;
  handleCall(next); next.emit('stream', nextStream);
  assert.equal(screens.peer, oldStream); assert.equal(old.closes, 0);
  nextTrack.muted = false; nextTrack.dispatchEvent(new Event('unmute'));
  assert.equal(screens.peer, nextStream); assert.equal(old.closes, 1);
  oldTrack.end(); assert.equal(screens.peer, nextStream);
  const cancelled = new Call(), waitingTrack = new Track('video'); waitingTrack.muted = true;
  handleCall(cancelled); cancelled.emit('stream', new Stream(waitingTrack)); cancelled.close();
  waitingTrack.muted = false; waitingTrack.dispatchEvent(new Event('unmute'));
  assert.equal(screens.peer, undefined);
});

test('production retry cannot republish a capture stopped during backoff', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const media = new Stream(new Track('video')), calls = [], cameraStreamRef = { current: media };
  const env = { disposed: false, localPeer: { open: true, call: () => { const call = new Call(); calls.push(call); return call; } },
    connections: new Map([['peer', { open: true }]]), outgoingCalls: new Map(),
    displayNameRef: { current: 'self' }, identityIdRef: { current: 'self' }, cameraStreamRef,
    microphoneStreamRef: { current: null }, screenStreamRef: { current: null },
    window: { setTimeout }, callPeerRef: {}, mediaCallReusable, watchMediaNegotiation, mediaRecovery: { cancel() {} },
  };
  const callPeer = extract('    const callPeer = (peerId:', '    const broadcastPeerList', env, 'callPeer');
  callPeer('peer', media, 'camera'); calls[0].emit('error'); cameraStreamRef.current = null;
  t.mock.timers.tick(130_000); assert.equal(calls.length, 1);
});

test('queued publisher repairs expire with their stream or call and recovered calls cancel cooldown work', () => {
  let time = 0, version = {}, stream = new Stream(new Track('video')), online = true;
  const sent = [];
  const recovery = createMediaRecovery({ peers: () => ['peer'], canSend: () => online, now: () => time,
    stream: () => stream, version: () => version, restart: (...args) => sent.push(args) });
  recovery.request('camera');
  time = 750; recovery.request('camera');
  version = {}; time = 15_000; recovery.flush(); assert.equal(sent.length, 1);
  online = false; recovery.request('camera'); stream = new Stream(new Track('video'));
  online = true; recovery.flush(); assert.equal(sent.length, 1);
  recovery.request('camera'); time += 750; recovery.request('camera'); recovery.cancel('camera', 'peer');
  time += 20_000; recovery.flush(); assert.equal(sent.length, 2);
});

test('incoming repairs preserve the observed call id and are cancelled when media returns', () => {
  let online = false; const sent = [];
  const recovery = createIncomingMediaRecovery({ send: (...args) => { if (!online) return false; sent.push(args); return true; }, reconnect() {} });
  recovery.request('peer', 'camera', 'old'); recovery.cancel('peer', 'camera'); online = true; recovery.flush();
  assert.deepEqual(sent, []);
  recovery.request('peer', 'camera', 'new'); assert.deepEqual(sent, [['peer', 'camera', 'new']]);
});

test('production sender ignores delayed repairs and health reports from an older call', () => {
  const requested = [], cancelled = [];
  const run = payload => extract('        if (message.type === "media-request") {', '        if (message.type === "task-snapshot"', {
    message: payload, payload, peerId: 'peer', outgoingCalls: new Map([['camera:peer', { connectionId: 'new' }]]),
    mediaRecovery: { request: (...args) => requested.push(args), cancel: (...args) => cancelled.push(args) },
  }, 'undefined');
  run({ type: 'media-request', repair: true, source: 'camera', callId: 'old' });
  run({ type: 'media-request', healthy: true, source: 'camera', callId: 'old' });
  assert.deepEqual(requested, []); assert.deepEqual(cancelled, []);
  run({ type: 'media-request', repair: true, source: 'camera', callId: 'new' });
  run({ type: 'media-request', healthy: true, source: 'camera', callId: 'new' });
  assert.deepEqual(requested, [['camera', 'peer']]); assert.deepEqual(cancelled, [['camera', 'peer']]);
});

test('production caller permits a nine-second handshake, retains old media and clears negotiation timers', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const media = new Stream(new Track('video')), calls = [], outgoingCalls = new Map();
  const env = { disposed: false, localPeer: { open: true, call: () => { const call = new Call(); calls.push(call); return call; } },
    connections: new Map([['peer', { open: true }]]), outgoingCalls,
    displayNameRef: { current: 'self' }, identityIdRef: { current: 'self' }, cameraStreamRef: { current: media },
    microphoneStreamRef: { current: null }, screenStreamRef: { current: null },
    window: { setTimeout }, callPeerRef: {}, mediaCallReusable, watchMediaNegotiation, mediaRecovery: { cancel() {} },
  };
  const callPeer = extract('    const callPeer = (peerId:', '    const broadcastPeerList', env, 'callPeer');
  callPeer('peer', media, 'camera'); t.mock.timers.tick(9000);
  assert.equal(calls.length, 1); assert.equal(calls[0].closes, 0);
  calls[0].open = true; calls[0].peerConnection.state('connected');
  callPeer('peer', media, 'camera', 0, true);
  assert.equal(calls[0].closes, 0, 'old connection remains during negotiation');
  t.mock.timers.tick(9000); calls[1].open = true; calls[1].peerConnection.state('connected');
  assert.equal(calls[0].closes, 1);
  t.mock.timers.tick(120_000); assert.equal(calls.length, 2); assert.equal(calls[1].closes, 0);
  calls[1].close();
});

test('negotiation observes progress, fails on transport failure and has a bounded total deadline', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pc = new PC(); let failures = 0;
  watchMediaNegotiation(pc, () => failures++);
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(30_000); pc.dispatchEvent(new Event('signalingstatechange')); }
  assert.equal(failures, 0); t.mock.timers.tick(30_000); assert.equal(failures, 1);
  const broken = new PC(); watchMediaNegotiation(broken, () => failures++); broken.state('failed');
  assert.equal(failures, 2); t.mock.timers.tick(120_000); assert.equal(failures, 2);
  const stalled = new PC(); watchMediaNegotiation(stalled, () => failures++);
  t.mock.timers.tick(45_000); assert.equal(failures, 3);
});

test('paused video resumes automatically, exposes blocked playback, and recovers by gesture without detaching', async () => {
  const doc = new EventTarget(), win = new EventTarget(); doc.visibilityState = 'visible';
  class Video extends EventTarget {
    paused = false; readyState = 4; allow = true;
    play() { if (!this.allow) return Promise.reject({ name: 'NotAllowedError' }); this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  }
  const video = new Video(), stream = new Stream(new Track('video')), blocked = [];
  const playback = attachVideoPlayback(video, stream, { document: doc, window: win, blocked: value => blocked.push(value) });
  await Promise.resolve(); video.pause(); await Promise.resolve();
  assert.equal(video.paused, false); assert.equal(blocked.at(-1), false);
  video.allow = false; video.pause(); await Promise.resolve();
  assert.equal(video.paused, true); assert.equal(blocked.at(-1), true);
  video.allow = true; doc.dispatchEvent(new Event('pointerup')); await Promise.resolve();
  assert.equal(video.paused, false); assert.equal(blocked.at(-1), false); assert.equal(video.srcObject, stream);
  playback.dispose(); const count = blocked.length; video.pause(); assert.equal(blocked.length, count);
});
