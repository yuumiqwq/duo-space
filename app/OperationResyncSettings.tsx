"use client";

import { useState } from 'react';
import type { OperationView, OperationResyncCommand } from './collaboration-types';

export function OperationResyncSettings({ operation, disabled, perform }: { operation: OperationView; disabled: boolean; perform: (command: OperationResyncCommand) => Promise<boolean> }) {
  const [armedTarget, setArmedTarget] = useState<string | null>(null);
  const target = `${operation.id}:${operation.updatedAt}`, armed = armedTarget === target;
  if (operation.action !== 'update' || operation.status !== 'pending' || !operation.from || !operation.error.includes('任务已被修改')) return null;
  return <button type="button" disabled={disabled} onClick={() => {
    if (!armed) { setArmedTarget(target); return; }
    setArmedTarget(null);
    void perform({ id: crypto.randomUUID(), operationId: operation.id, updatedAt: operation.updatedAt, action: 'resync-operation' });
  }}>{armed ? '确认以网站设置覆盖滴答' : '以网站设置同步'}</button>;
}
