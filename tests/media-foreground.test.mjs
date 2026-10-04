import test from 'node:test';
import assert from 'node:assert/strict';
import { onMediaForeground } from '../app/media-foreground.ts';
import { attachVideoPlayback } from '../app/video-playback.ts';

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
test('focus return reattaches a frozen decoder even when paused is false; PiP stays attached', t => {
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
  assert.equal(video.detaches, before + 1);
  s.doc.pictureInPictureElement = video;
  s.win.dispatchEvent(new Event('focus')); t.mock.timers.tick(250);
  assert.equal(video.detaches, before + 1);
  playback.dispose(); s.dispose();
});
