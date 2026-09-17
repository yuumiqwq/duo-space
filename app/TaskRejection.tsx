"use client";

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw, X } from 'lucide-react';
import type { TaskNotice } from './collaboration-notifications';
import { attachmentDisplayText } from './task-description-attachments';
import { WorkflowAttachments } from './WorkflowAttachments';

export function TaskRejection({ notice, onDismiss, onClose }: { notice: TaskNotice; onDismiss: (id: string) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), dismissing = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const previous = document.activeElement, element = dialog.current;
    // Open after any taskboard/detail effects from the same response so this
    // acknowledgement remains above them. Attachment previews can open above it.
    const frame = requestAnimationFrame(() => { if (element && !element.open) element.showModal(); });
    return () => { cancelAnimationFrame(frame); element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  async function dismiss() {
    if (dismissing.current) return;
    dismissing.current = true; setBusy(true); setError('');
    try { await onDismiss(notice.id); onClose(); }
    catch { setError('浏览状态尚未保存，请重试'); }
    finally { dismissing.current = false; setBusy(false); }
  }
  return createPortal(<dialog ref={dialog} className="task-nudge-dialog" aria-labelledby="task-rejection-title" onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) void dismiss(); }} onKeyDown={event => event.stopPropagation()}>
    <header><RotateCcw size={23} /><h3 id="task-rejection-title">打回修改</h3><button type="button" className="coop-icon" aria-label="关闭打回提醒" disabled={busy} onClick={() => void dismiss()}><X size={20} /></button></header>
    <h4>{notice.title}</h4>
    {notice.rejection?.comment && <p style={{ whiteSpace: 'pre-wrap' }}>{attachmentDisplayText(notice.rejection.comment)}</p>}
    <WorkflowAttachments files={notice.rejection?.files || []} />
    {error && <p className="coop-feedback error" role="alert">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={() => void dismiss()}>关闭</button></footer>
  </dialog>, document.body);
}
