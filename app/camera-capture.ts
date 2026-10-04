export function createCameraCapture(options: {
  capture: () => Promise<MediaStream>;
  publish: (stream: MediaStream) => Promise<void>;
  release: (stream: MediaStream) => void;
  changed: (stream: MediaStream | null) => void;
  error: (error: unknown) => void;
}) {
  let generation = 0;
  let pending = false;
  let current: MediaStream | null = null;
  const release = (stream: MediaStream) => {
    options.release(stream);
    stream.getTracks().forEach(track => track.stop());
  };
  const stop = () => {
    ++generation;
    // Keep the in-flight capture locked until it settles; Safari must not
    // receive another getUserMedia request while the old prompt is pending.
    const previous = current;
    current = null;
    if (previous) release(previous);
    options.changed(null);
  };
  return {
    stop,
    async start() {
      if (pending || current) return;
      pending = true;
      const request = ++generation;
      let captured: MediaStream | null = null;
      try {
        captured = await options.capture();
        if (request !== generation) { release(captured); return; }
        const track = captured.getVideoTracks()[0];
        if (!track || track.readyState !== 'live') throw new Error('No live camera track');
        await options.publish(captured);
        if (request !== generation || track.readyState !== 'live') { release(captured); return; }
        const stream = captured;
        current = stream;
        track.addEventListener('ended', () => {
          // A late event from an old capture must never clear a newer one.
          if (current === stream) stop();
        }, { once: true });
        options.changed(stream);
      } catch (error) {
        if (captured) release(captured);
        if (request === generation) options.error(error);
      } finally {
        pending = false;
      }
    },
  };
}
