import type { MediaSource } from './media-recovery.ts';

export function whenRemoteMediaReady(stream: MediaStream, source: MediaSource, ready: () => void) {
  const tracks = new Set<MediaStreamTrack>();
  let disposed = false;
  const dispose = () => {
    disposed = true;
    stream.removeEventListener('addtrack', sync);
    stream.removeEventListener('removetrack', sync);
    for (const track of tracks) track.removeEventListener('unmute', check);
    tracks.clear();
  };
  const check = () => {
    if (!disposed && [...tracks].some(track => track.readyState === 'live' && !track.muted)) { dispose(); ready(); }
  };
  const sync = () => {
    for (const track of tracks) track.removeEventListener('unmute', check);
    tracks.clear();
    const relevant = source === 'microphone' ? stream.getAudioTracks() : stream.getVideoTracks();
    for (const track of relevant) { tracks.add(track); track.addEventListener('unmute', check); }
    check();
  };
  stream.addEventListener('addtrack', sync);
  stream.addEventListener('removetrack', sync);
  sync();
  return dispose;
}

// Screen audio and video may arrive in either order. Only the tracks belonging
// to this display source determine its lifetime, including later replacements.
export function watchRemoteMediaTracks(stream: MediaStream, source: MediaSource, ended: () => void) {
  const tracks = new Set<MediaStreamTrack>();
  let disposed = false, observed = false;
  const check = () => {
    if (!disposed && observed && ![...tracks].some(track => track.readyState === 'live')) ended();
  };
  const sync = () => {
    for (const track of tracks) track.removeEventListener('ended', check);
    tracks.clear();
    const relevant = source === 'microphone' ? stream.getAudioTracks() : stream.getVideoTracks();
    for (const track of relevant) { tracks.add(track); track.addEventListener('ended', check); }
    observed ||= tracks.size > 0;
    check();
  };
  stream.addEventListener('addtrack', sync);
  stream.addEventListener('removetrack', sync);
  sync();
  return () => {
    disposed = true;
    stream.removeEventListener('addtrack', sync);
    stream.removeEventListener('removetrack', sync);
    for (const track of tracks) track.removeEventListener('ended', check);
    tracks.clear();
  };
}
