"use client";

import { useEffect, useRef, useState } from 'react';
import { prepareRenderedClassroom } from './classroom-render-ready';

export function useClassroomEntry(contentReady: boolean) {
  const root = useRef<HTMLElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!contentReady || ready || !root.current) return;
    const controller = new AbortController();
    void prepareRenderedClassroom(root.current, controller.signal).then(() => {
      if (!controller.signal.aborted) setReady(true);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '教室未能加载，请重试。');
    });
    return () => controller.abort();
  }, [contentReady, ready]);
  return { root, ready, error };
}
