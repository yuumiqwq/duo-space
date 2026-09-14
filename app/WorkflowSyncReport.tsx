"use client";

import { useRef, useState } from 'react';
import { readTaskResponse, taskErrorMessage } from './task-request';
import './ticktick-diagnostics.css';
import type { TaskNotice } from './collaboration-notifications';

export function WorkflowSyncAlert({ notice, open, dismiss, fixed = false }: { notice: TaskNotice; open: () => void; dismiss: () => void; fixed?: boolean }) {
  return <div className="coop-toast error" role="alert" style={fixed ? { position: 'fixed', zIndex: 100 } : undefined}>
    <span>{notice.title}：{notice.body}</span><button type="button" onClick={open}>查看错误</button><button type="button" onClick={dismiss}>稍后</button>
  </div>;
}

export function WorkflowSyncReport({ workflowId, disabled }: { workflowId: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false), [copied, setCopied] = useState(false);
  const [report, setReport] = useState(''), [error, setError] = useState('');
  const locked = useRef(false), output = useRef<HTMLTextAreaElement>(null);
  async function copyReport() {
    if (locked.current || disabled) return;
    locked.current = true; setBusy(true); setCopied(false); setError(''); setReport('');
    try {
      const response = await fetch(`/api/room/tasks?workflow-diagnostic=${encodeURIComponent(workflowId)}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const data = await readTaskResponse(response, '错误报告暂时无法读取');
      if (data.workflowId !== workflowId) throw new Error('错误报告与任务不符');
      const text = JSON.stringify(data, null, 2);
      try { await navigator.clipboard.writeText(text); setCopied(true); }
      catch { setReport(text); requestAnimationFrame(() => { output.current?.focus(); output.current?.select(); }); }
    } catch (cause) { setError(taskErrorMessage(cause, '错误报告暂时无法读取')); }
    finally { locked.current = false; setBusy(false); }
  }
  return <div className="ticktick-diagnostics">
    <button type="button" disabled={disabled || busy} onClick={() => void copyReport()}>{busy ? '正在读取…' : copied ? '已复制错误报告' : '复制错误报告'}</button>
    {report && <div className="ticktick-diagnostic-result"><textarea ref={output} readOnly aria-label="错误报告，可手动复制" value={report} rows={7} onFocus={event => event.target.select()} /></div>}
    {error && <p className="coop-feedback error" role="alert">{error}</p>}
  </div>;
}
