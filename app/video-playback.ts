import { onMediaForeground } from './media-foreground.ts';

export function attachVideoPlayback(video: HTMLVideoElement, stream: MediaStream, options: {
  blocked: (value: boolean) => void;
  document?: Document;
  window?: Window;
}) {
  const doc = options.document ?? document, win = options.window ?? window;
  let disposed = false, attempt = 0;
  const tracks = new Set<MediaStreamTrack>();
  const resume = (reattach = false) => {
    if (disposed || doc.visibilityState !== 'visible') return;
    if (!stream.getVideoTracks().some(track => track.readyState === 'live' && !track.muted)) return;
    if (reattach && doc.pictureInPictureElement !== video) {
      video.pause();
      video.srcObject = null;
      video.srcObject = stream;
    }
    const request = ++attempt;
    void video.play().then(() => {
      if (!disposed && request === attempt) options.blocked(false);
    }, error => {
      if (!disposed && request === attempt && error?.name !== 'AbortError') options.blocked(true);
    });
  };
  const unmute = () => resume(true);
  const syncTracks = () => {
    for (const track of tracks) track.removeEventListener('unmute', unmute);
    tracks.clear();
    for (const track of stream.getVideoTracks()) {
      tracks.add(track);
      track.addEventListener('unmute', unmute);
    }
    resume(true);
  };
  const ready = () => { if (video.paused) resume(); };
  const gesture = () => { if (video.paused || video.readyState < 2) resume(); };
  const stopForeground = onMediaForeground(doc, win, () => resume(true));
  // Set Safari's inline/autoplay requirements before assigning the stream.
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = stream;
  video.addEventListener('loadedmetadata', ready);
  video.addEventListener('canplay', ready);
  stream.addEventListener('addtrack', syncTracks);
  stream.addEventListener('removetrack', syncTracks);
  doc.addEventListener('pointerup', gesture);
  doc.addEventListener('keydown', gesture);
  syncTracks();
  return {
    resume: () => resume(true),
    dispose() {
      disposed = true; ++attempt;
      video.removeEventListener('loadedmetadata', ready);
      video.removeEventListener('canplay', ready);
      stream.removeEventListener('addtrack', syncTracks);
      stream.removeEventListener('removetrack', syncTracks);
      stopForeground();
      doc.removeEventListener('pointerup', gesture);
      doc.removeEventListener('keydown', gesture);
      for (const track of tracks) track.removeEventListener('unmute', unmute);
      if (video.srcObject === stream) { video.pause(); video.srcObject = null; }
    },
  };
}
