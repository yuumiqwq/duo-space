"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { showCollaborationDialog } from './collaboration-dialog';

export function CollaborationRecovery({ busy, onClose, children }: { busy: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement;
    showCollaborationDialog(element);
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="coop-recovery-dialog" aria-label="待处理的协作操作" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><h3>待处理</h3><button type="button" className="coop-icon" disabled={busy} aria-label="关闭待处理面板" onClick={onClose}><X size={18} /></button></header>
    <div className="coop-recovery-content">{children}</div>
  </dialog>;
}
