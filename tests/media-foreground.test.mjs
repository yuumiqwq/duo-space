import test from 'node:test';
import assert from 'node:assert/strict';
import { onMediaForeground } from '../app/media-foreground.ts';
import { attachVideoPlayback } from '../app/video-playback.ts';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('foreground reconciliation preserves every source and never requests a forced reconnect', async () => {
  const page = await readFile('app/room/use-peer-room.ts', 'utf8');
  const start = page.indexOf('    const resumeMedia = () => {');
  const end = page.indexOf('    const handleVisibilityChange', start);
  assert.ok(start > 0 && end > start);
  const repairs = [], messages = [], calls = [];
  const stream = {};
  runInNewContext(page.slice(start, end) + '\nresumeMedia();', {
    mediaRecovery: { request: source => repairs.push(source) },
    connections: new Map([['peer', { open: true, peer: 'peer', send: message => messages.push(message) }]]),
    screenStreamRef: { current: stream },
    cameraStreamRef: { current: stream },
    microphoneStreamRef: { current: stream },
    callPeer: (...args) => calls.push(args),
  });
  assert.deepEqual(repairs, []);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'media-request');
  assert.ok(!messages[0].repair);
  assert.deepEqual(calls, [['peer', stream, 'screen'], ['peer', stream, 'camera'], ['peer', stream, 'microphone']]);
});

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = new EventTarget(), win = new EventTarget();
  doc.visibilityState = 'visible';
  let repairs = 0;
  const dispose = onMediaForeground(doc, win, () => repairs++);
  return { doc, win, dispose, repairs: () => repairs };
}
test('focus-only desktop return repairs without a hidden event', t => {
  const s = setup(t);
  s.win.dispatchEvent(new Event('focus'));
  t.mock.timers.tick(250);
  assert.equal(s.repairs(), 1);
  s.dispose();
});
test('quick desktop switches recover and duplicate foreground events coalesce', t => {
  const s = setup(t);
  s.doc.visibilityState = 'hidden';
  s.doc.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(100);
  s.doc.visibilityState = 'visible';
  s.doc.dispatchEvent(new Event('visibilitychange'));
  s.win.dispatchEvent(new Event('focus'));
  s.win.dispatchEvent(new Event('pageshow'));
  s.doc.dispatchEvent(new Event('resume'));
  t.mock.timers.tick(250);
  assert.equal(s.repairs(), 1);
  s.dispose();
});
test('returning to background or leaving the room cancels pending repairs', t => {
  const s = setup(t);
  s.win.dispatchEvent(new Event('focus'));
  s.doc.visibilityState = 'hidden';
  s.doc.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(500);
  assert.equal(s.repairs(), 0);
  s.doc.visibilityState = 'visible';
  s.win.dispatchEvent(new Event('focus'));
  s.dispose();
  t.mock.timers.tick(500);
  s.win.dispatchEvent(new Event('focus'));
  t.mock.timers.tick(500);
  assert.equal(s.repairs(), 0);
});
test('camera focus preserves rendered video; empty playback can reattach and PiP stays attached', t => {
  const s = setup(t);
  class Video extends EventTarget {
    paused = false; readyState = 4; calls = 0; detaches = 0;
    set srcObject(value) { if (value === null) this.detaches++; this.source = value; }
    get srcObject() { return this.source; }
    play() { this.calls++; this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  const track = new EventTarget(); track.readyState = 'live'; track.muted = false;
  const stream = new EventTarget(); stream.getVideoTracks = () => [track];
  const video = new Video();
  const playback = attachVideoPlayback(video, stream, { document: s.doc, window: s.win, blocked: () => {} });
  const before = video.detaches;
  s.win.dispatchEvent(new Event('focus')); t.mock.timers.tick(250);
  assert.equal(video.detaches, before);
  video.readyState = 0;
  s.win.dispatchEvent(new Event('focus')); t.mock.timers.tick(250);
  assert.equal(video.detaches, before + 1);
  s.doc.pictureInPictureElement = video;
  s.win.dispatchEvent(new Event('focus')); t.mock.timers.tick(250);
  assert.equal(video.detaches, before + 1);
  playback.dispose(); s.dispose();
});

test('healthy screen playback stays attached across focus, track changes and unmute; empty playback recovers', t => {
  const s = setup(t);
  class Video extends EventTarget {
    paused = false; readyState = 4; detaches = 0;
    set srcObject(value) { if (value === null) this.detaches++; this.source = value; }
    get srcObject() { return this.source; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  const track = new EventTarget(); track.readyState = 'live'; track.muted = false;
  const stream = new EventTarget(); stream.getVideoTracks = () => [track];
  const video = new Video();
  const playback = attachVideoPlayback(video, stream, { document: s.doc, window: s.win, screen: true, blocked: () => {} });
  for (const event of ['focus', 'pageshow']) { s.win.dispatchEvent(new Event(event)); t.mock.timers.tick(250); }
  stream.dispatchEvent(new Event('addtrack'));
  track.dispatchEvent(new Event('unmute'));
  assert.equal(video.detaches, 0);
  video.paused = true;
  s.win.dispatchEvent(new Event('focus')); t.mock.timers.tick(250);
  assert.equal(video.paused, false);
  assert.equal(video.detaches, 0);
  video.readyState = 0;
  s.win.dispatchEvent(new Event('focus')); t.mock.timers.tick(250);
  assert.equal(video.detaches, 1);
  playback.dispose(); s.dispose();
});
