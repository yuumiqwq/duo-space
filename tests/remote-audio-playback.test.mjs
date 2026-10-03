import test from 'node:test';
import assert from 'node:assert/strict';
import { attachRemoteAudio } from '../app/remote-audio-playback.ts';
class Track extends EventTarget { kind = 'audio'; readyState = 'live'; }
class Stream extends EventTarget {
  constructor(tracks = []) { super(); this.tracks = tracks; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
}
class Audio extends EventTarget {
  paused = true; muted = true; volume = 0; calls = 0; reject = false;
  play() { this.calls++; if (this.reject) return Promise.reject(new Error('blocked')); this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(tracks = [new Track()]) {
  const audio = new Audio(), stream = new Stream(tracks), doc = new EventTarget(), win = new EventTarget(), states = [];
  doc.visibilityState = 'visible';
  const controller = attachRemoteAudio(audio, stream, {document: doc, window: win, createStream: tracks => new Stream(tracks), onBlocked: b => states.push(b)});
  return {audio, stream, doc, win, states, controller};
}
test('late audio tracks attach without replacing the original received stream', async () => {
  const s = setup([]); assert.equal(s.audio.calls, 0);
  const track = new Track(); s.stream.tracks.push(track); s.stream.dispatchEvent(new Event('addtrack'));
  await tick(); assert.deepEqual(s.audio.srcObject.getAudioTracks(), [track]); assert.equal(s.audio.paused, false);
  track.readyState = 'ended'; track.dispatchEvent(new Event('ended'));
  assert.equal(s.audio.srcObject, null); s.controller.dispose();
});
test('blocked and interrupted playback recovers from interaction and foreground events', async () => {
  const s = setup(); await tick(); s.audio.reject = true; s.controller.resume(); await tick();
  assert.equal(s.states.at(-1), true);
  s.audio.reject = false; s.doc.dispatchEvent(new Event('pointerup')); await tick(); assert.equal(s.states.at(-1), false);
  s.audio.pause(); assert.equal(s.states.at(-1), true);
  s.doc.dispatchEvent(new Event('visibilitychange')); await tick(); assert.equal(s.audio.paused, false);
  s.audio.pause(); s.win.dispatchEvent(new Event('pageshow')); await tick(); assert.equal(s.audio.paused, false);
  s.controller.dispose();
});
test('video is excluded, explicit mute survives interactions, cleanup leaves received tracks live', async () => {
  const audioTrack = new Track(), video = new Track(); video.kind = 'video';
  const s = setup([audioTrack, video]); await tick(); assert.deepEqual(s.audio.srcObject.tracks, [audioTrack]);
  s.controller.setMuted(true); const before = s.audio.calls;
  s.doc.dispatchEvent(new Event('pointerup')); s.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(s.audio.calls, before); assert.equal(s.audio.muted, true);
  s.controller.setMuted(false); assert.equal(s.audio.muted, false);
  s.controller.dispose(); const after = s.audio.calls;
  s.doc.dispatchEvent(new Event('pointerup')); audioTrack.dispatchEvent(new Event('unmute')); s.stream.dispatchEvent(new Event('addtrack'));
  assert.equal(s.audio.calls, after); assert.equal(s.audio.srcObject, null); assert.equal(audioTrack.readyState, 'live');
});
test('an obsolete rejected play promise cannot override a successful newer play', async () => {
  const s = setup(); await tick(); let reject;
  s.audio.play = () => new Promise((_resolve, r) => { reject = r; }); s.controller.resume();
  s.audio.play = () => Promise.resolve(); s.controller.resume(); await tick();
  reject(new Error('old request')); await tick(); assert.equal(s.states.at(-1), false); s.controller.dispose();
});
