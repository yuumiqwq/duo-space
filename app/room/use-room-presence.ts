"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { isMobileBrowser } from './model';
import { createRoomPresence, type RoomParticipant } from './room-presence';

export function useRoomPresence({ joined, selfPeerIdRef, displayNameRef, intentionalLeaveRef }: {
  joined: boolean;
  selfPeerIdRef: RefObject<string>;
  displayNameRef: RefObject<string>;
  intentionalLeaveRef: RefObject<boolean>;
}) {
  const [participants, setParticipants] = useState<RoomParticipant[]>([]);
  const deviceIdRef = useRef('');
  const sessionRef = useRef<ReturnType<typeof createRoomPresence> | null>(null);
  const participantsRef = useRef<RoomParticipant[]>([]);
  const syncPresence = useCallback(async (background = document.hidden) => {
    await sessionRef.current?.sync(background);
    return participantsRef.current;
  }, []);

  useEffect(() => {
    if (!joined) return;
    // Each mounted room owns a lease, so two tabs cannot overwrite one another.
    const deviceId = crypto.randomUUID();
    deviceIdRef.current = deviceId;
    const mobile = isMobileBrowser();
    const session = createRoomPresence({
      deviceId, mobile, peerId: () => selfPeerIdRef.current, name: () => displayNameRef.current,
      changed: next => { participantsRef.current = next; setParticipants(next); },
      setTimer: (callback, delay) => window.setTimeout(callback, delay),
      clearTimer: timer => window.clearTimeout(timer as number),
    });
    sessionRef.current = session;
    const refresh = () => { void session.sync(document.hidden); };
    const resume = () => { void session.sync(document.hidden, true); };
    const leaving = () => intentionalLeaveRef.current;
    const unload = (event: PageTransitionEvent) => {
      if (!event.persisted && (!mobile || leaving())) session.close(true);
      else void session.sync(true, true);
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('pageshow', resume);
    window.addEventListener('pagehide', unload);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('pagehide', unload);
      session.close(!mobile || leaving());
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [joined, selfPeerIdRef, displayNameRef, intentionalLeaveRef]);
  return { participants, deviceIdRef, syncPresence };
}
