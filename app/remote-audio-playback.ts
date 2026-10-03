// RTP reception and audible playback have independent lifecycles.
export function attachRemoteAudio(audio: HTMLAudioElement, stream: MediaStream, options: {
  onBlocked: (blocked: boolean) => void;
  muted?: boolean;
  document?: Document;
  window?: Window;
  createStream?: (tracks: MediaStreamTrack[]) => MediaStream;
}) {
  const doc = options.document ?? document;
  const win = options.window ?? window;
  const createStream = options.createStream ?? ((tracks) => new MediaStream(tracks));
  let disposed = false;
  let muted = options.muted ?? false;
  let attempt = 0;
  let tracks: MediaStreamTrack[] = [];
  const playable = () => !muted && tracks.some(track => track.readyState === 'live');
  const resume = () => {
    if (disposed || !playable()) return;
    const current = ++attempt;
    // Call synchronously during user activation; ignore superseded promises.
    void audio.play().then(() => {
      if (!disposed && current === attempt) options.onBlocked(false);
    }, () => {
      if (!disposed && current === attempt && playable()) options.onBlocked(true);
    });
  };
  const syncTracks = () => {
    const next = stream.getAudioTracks().filter(track => track.readyState === 'live');
    if (next.length === tracks.length && next.every((track, i) => track === tracks[i])) return;
    for (const track of tracks) {
      track.removeEventListener('unmute', resume);
      track.removeEventListener('ended', syncTracks);
    }
    tracks = next;
    ++attempt;
    // Keep video out of the audio sink. Never stop tracks owned by the call.
    audio.srcObject = tracks.length ? createStream(tracks) : null;
    for (const track of tracks) {
      track.addEventListener('unmute', resume);
      track.addEventListener('ended', syncTracks);
    }
    if (!tracks.length) options.onBlocked(false);
    resume();
  };
  const foreground = () => { if (doc.visibilityState === 'visible') resume(); };
  const paused = () => { if (!disposed && playable() && audio.paused) options.onBlocked(true); };
  const playing = () => { if (!disposed) options.onBlocked(false); };
  audio.muted = muted;
  audio.volume = 1;
  stream.addEventListener('addtrack', syncTracks);
  stream.addEventListener('removetrack', syncTracks);
  audio.addEventListener('loadedmetadata', resume);
  audio.addEventListener('canplay', resume);
  audio.addEventListener('pause', paused);
  audio.addEventListener('playing', playing);
  doc.addEventListener('pointerup', resume);
  doc.addEventListener('keydown', resume);
  doc.addEventListener('visibilitychange', foreground);
  win.addEventListener('pageshow', foreground);
  syncTracks();
  return {
    resume,
    setMuted(value: boolean) {
      muted = value;
      audio.muted = value;
      if (value) { ++attempt; options.onBlocked(false); }
      else resume();
    },
    dispose() {
      disposed = true;
      ++attempt;
      stream.removeEventListener('addtrack', syncTracks);
      stream.removeEventListener('removetrack', syncTracks);
      for (const track of tracks) {
        track.removeEventListener('unmute', resume);
        track.removeEventListener('ended', syncTracks);
      }
      audio.removeEventListener('loadedmetadata', resume);
      audio.removeEventListener('canplay', resume);
      audio.removeEventListener('pause', paused);
      audio.removeEventListener('playing', playing);
      doc.removeEventListener('pointerup', resume);
      doc.removeEventListener('keydown', resume);
      doc.removeEventListener('visibilitychange', foreground);
      win.removeEventListener('pageshow', foreground);
      audio.pause();
      audio.srcObject = null;
    },
  };
}
