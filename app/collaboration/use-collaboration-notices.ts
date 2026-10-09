"use client";
import { useCallback,useRef,useState } from "react";
import { nextTaskPrompt,type TaskNotice } from "../collaboration-notifications";
import { readTaskResponse } from '../task-request';

type Options = {
  onNotice: ((id: string) => void) | undefined;
  identityId: string;
};
export function useCollaborationNotices({ onNotice, identityId }: Options) {

  const [taskNotices, setTaskNotices] = useState<TaskNotice[]>([]);
  const [taskPrompt, setTaskPrompt] = useState<TaskNotice | null>(null);
  const readIds = useRef(new Set<string>()), sounded = useRef(new Set<string>());
  const noticeVersion = useRef(0);

  const acceptNotices = useCallback((incoming: TaskNotice[], version = 0) => {
    if (version < noticeVersion.current) return;
    noticeVersion.current = version;
    const unread = incoming.filter(item => !readIds.current.has(item.id));
    setTaskNotices(unread);
    if (!document.hidden) {
      const fresh = unread.filter(item => !sounded.current.has(item.id));
      for (const item of fresh) sounded.current.add(item.id);
      if (fresh.length) onNotice?.(fresh.at(-1)!.id);
      setTaskPrompt(current => nextTaskPrompt(unread, identityId, current));
    }
  }, [identityId, onNotice]);
  const markRead = useCallback(async (ids: string[]) => {
    const pending = ids.filter(id => !readIds.current.has(id)); if (!pending.length) return;
    const response = await fetch("/api/room/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "read-notices", ids: pending }), signal: AbortSignal.timeout(15000) });
    const data = await readTaskResponse(response, '浏览状态未保存');
    for (const id of pending) readIds.current.add(id);
    acceptNotices(data.notices || [], data.noticeVersion);
  }, [acceptNotices]);
  const markViewed = useCallback((ids: string[]) => { void markRead(ids).catch(() => undefined); }, [markRead]);
  const dismissRejection = useCallback(async (id: string) => {
    const response = await fetch('/api/room/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'dismiss-rejection', noticeId: id }), signal: AbortSignal.timeout(15000) });
    const data = await readTaskResponse(response, '浏览状态未保存');
    acceptNotices(data.notices || [], data.noticeVersion);
  }, [acceptNotices]);
  return { taskNotices, taskPrompt, setTaskPrompt, acceptNotices, markRead, markViewed, dismissRejection };
}
