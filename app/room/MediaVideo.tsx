"use client";
import { useEffect,useRef,useState } from "react";
import { attachVideoPlayback } from '../video-playback';
export function MediaVideo({ stream, label, className, screen }: { stream: MediaStream; label: string; className: string; screen: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const playback = useRef<ReturnType<typeof attachVideoPlayback> | null>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const controller = attachVideoPlayback(ref.current, stream, { blocked: setBlocked, screen });
    playback.current = controller;
    return () => { controller.dispose(); playback.current = null; };
  }, [stream, screen]);
  return <>
    <video className={className} ref={ref} autoPlay muted playsInline disablePictureInPicture={false} aria-label={label} />
    {blocked && <div className="media-window-actions"><button className="remote-audio-button" type="button" onClick={() => playback.current?.resume()}>播放画面</button></div>}
  </>;
}
