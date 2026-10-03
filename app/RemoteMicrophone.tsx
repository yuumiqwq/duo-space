"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { attachRemoteAudio } from './remote-audio-playback';

type Source = { id: string; stream: MediaStream; muted?: boolean };
type Playback = ReturnType<typeof attachRemoteAudio>;

function RemoteAudio({ source, register, onBlocked }: {
  source: Source;
  register: (id: string, playback: Playback | null) => void;
  onBlocked: (id: string, blocked: boolean) => void;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const playback = useRef<Playback | null>(null);
  const { id, stream, muted = false } = source;
  const mutedRef = useRef(muted);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => {
    if (!ref.current) return;
    const controller = attachRemoteAudio(ref.current, stream, { muted: mutedRef.current, onBlocked: value => onBlocked(id, value) });
    playback.current = controller;
    register(id, controller);
    return () => {
      controller.dispose();
      playback.current = null;
      register(id, null);
      onBlocked(id, false);
    };
  }, [id, stream, register, onBlocked]);
  useEffect(() => { playback.current?.setMuted(muted); }, [muted, stream]);
  return <audio ref={ref} data-room-audio={id} autoPlay />;
}

export function RemoteRoomAudio({ sources }: { sources: Source[] }) {
  const controllers = useRef(new Map<string, Playback>());
  const [blocked, setBlocked] = useState<Set<string>>(() => new Set());
  const register = useCallback((id: string, controller: Playback | null) => {
    if (controller) controllers.current.set(id, controller);
    else controllers.current.delete(id);
  }, []);
  const onBlocked = useCallback((id: string, value: boolean) => {
    setBlocked(current => {
      if (current.has(id) === value) return current;
      const next = new Set(current);
      if (value) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  return <>
    {sources.map(source => <RemoteAudio key={source.id} source={source} register={register} onBlocked={onBlocked} />)}
    {blocked.size > 0 && <button className="room-audio-enable" type="button" onClick={() => controllers.current.forEach(controller => controller.resume())}>开启房间声音</button>}
  </>;
}
