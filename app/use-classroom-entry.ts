"use client";

import { useEffect, useRef, useState } from 'react';
import { prepareClassroomFrame } from './classroom-entry';

export function useClassroomEntry(contentReady: boolean) {
  const root = useRef<HTMLElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!contentReady || ready || !root.current) return;
    const controller = new AbortController();
    void prepareClassroomFrame(root.current, controller.signal).then(() => {
      if (!controller.signal.aborted) setReady(true);
    }).catch(cause => {
      if (!controller.signal.aborted) {
        console.error('Classroom entry rendering failed', cause);
        setError(cause instanceof Error ? cause.message : 'Classroom entry rendering failed');
      }
    });
    return () => controller.abort();
  }, [contentReady, ready]);
  return { root, ready, error };
}
