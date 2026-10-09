"use client";
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { classroomTodoWindow, type TodoTask } from './classroom-todo';

export function useClassroomTodoClock() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer); const time = Date.now(); setNow(time);
      timer = setTimeout(update, Math.max(50, Math.min(60_000, classroomTodoWindow(time).next - time + 20)));
    };
    const visible = () => { if (!document.hidden) update(); };
    update(); document.addEventListener('visibilitychange', visible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, []);
  return now;
}

function TodoNote({ name, value, onSave }: { name: string; value: string; onSave?: (note: string) => Promise<void> | void }) {
  const [draft, setDraft] = useState(value), [editing, setEditing] = useState(false), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const composing = useRef(false), before = useRef('');
  return <form className="todo-note" onSubmit={event => {
    event.preventDefault(); if (!onSave || saving) return;
    setSaving(true); setError('');
    void Promise.resolve().then(() => onSave(draft)).then(() => setEditing(false)).catch(() => setError('小记保存失败，请重新按 Enter 保存')).finally(() => setSaving(false));
  }}>
    <input aria-label={`${name}的自由小记`} value={editing ? draft : value} readOnly={!onSave || saving} maxLength={24}
      onFocus={() => { if (onSave) { setDraft(value); setEditing(true); } }}
      onCompositionStart={event => { composing.current = true; before.current = event.currentTarget.value; }}
      onCompositionEnd={event => { composing.current = false; const input = event.currentTarget; const next = input.scrollWidth <= input.clientWidth + 1 ? input.value : before.current; input.value = next; setDraft(next); }}
      onChange={event => { const input = event.currentTarget; if (composing.current || input.scrollWidth <= input.clientWidth + 1 || input.value.length < draft.length) setDraft(input.value); else input.value = draft; }}
      onKeyDown={event => { if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return; event.preventDefault(); const input = event.currentTarget; input.form?.requestSubmit(); input.blur(); }} />
    {error && <small role="alert">{error}</small>}
  </form>;
}

export function ClassroomTodoCard<T extends TodoTask>({ name, tasks, note = '', onNoteSave, onComplete, headerActions, empty }: {
  name: string; tasks: T[]; note?: string; onNoteSave?: (note: string) => Promise<void> | void; onComplete?: (task: T) => void; headerActions?: ReactNode; empty?: ReactNode;
}) {
  return <section className="task-person-card todo-paper-card" aria-label={`${name}的今日任务`}>
    <div className="activity-heading"><strong >{name}</strong>{headerActions}<TodoNote name={name} value={note} onSave={onNoteSave} /></div>
    <div className="task-person-list" tabIndex={0} aria-label={`${name}的任务列表`}>
      <div className="task-list" aria-live="polite">{tasks.map(task => <div className={`task-row${task.done ? ' is-done' : ''}`} key={task.id}>
        <button className="todo-hand-check" type="button" role="checkbox" aria-checked={task.done} aria-label={`${task.done ? '已完成' : '完成任务'}：${task.title}`} disabled={!onComplete || task.done} onClick={() => onComplete?.(task)}><span aria-hidden="true" /></button>
        <span className="task-copy" ><strong>{task.title}</strong></span>
      </div>)}{!tasks.length && (empty || <p className="task-empty">今天没有待办</p>)}</div>
    </div>
  </section>;
}
