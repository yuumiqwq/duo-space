"use client";

import { FormEvent,useCallback,useEffect,useMemo,useRef,useState } from "react";
import { classroomTodoWindow,mergeTodoSnapshot } from "../classroom-todo";
import { taskRefresh } from "../task-refresh";
import { Task } from './model';

type Options = {
  today: string;
};

export function useRoomTasks({ today }: Options) {

  const [tasks, setTasks] = useState<Task[]>([]);
  const [syncOpen, setSyncOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [syncing, setSyncing] = useState(true);
  const [syncError, setSyncError] = useState("");
  const [token, setToken] = useState("");
  const tasksRef = useRef<Task[]>([]);


  const taskLoadVersionRef = useRef(0);
  const readTasks = useCallback(async (): Promise<boolean> => {
    const version = ++taskLoadVersionRef.current;
    setSyncing(true);
    setSyncError("");
    try {
      const response = await fetch("/api/ticktick/tasks?view=today&classroom=1", { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (version !== taskLoadVersionRef.current) return false;
      if (response.status === 401) {
        setConnected(false);
        setTasks((current) => current.filter((task) => task.source === "local"));
        return false;
      }
      if (!response.ok) throw new Error("暂时无法读取滴答清单");
      const data = await response.json();
      if (version !== taskLoadVersionRef.current) return false;
      if (!Array.isArray(data.tasks) || !Array.isArray(data.projects)) throw new Error("滴答返回的数据格式异常");
      const remoteTasks: Task[] = data.tasks.map((task: Task) => ({ ...task, source: "ticktick" }));
      setConnected(true);
      if (typeof data.inboxError === "string") setSyncError(data.inboxError);
      setTasks((current) => mergeTodoSnapshot(current, [...remoteTasks, ...current.filter((task) => task.source === "local")]));
      return true;
    } catch (error) {
      if (version !== taskLoadVersionRef.current) return false;
      setSyncError(error instanceof Error ? error.message : "同步失败");
      return false;
    } finally {
      if (version === taskLoadVersionRef.current) setSyncing(false);
    }
  }, []);
  // taskRefresh stores this callback; it only reads task refs when invoked later.
  // eslint-disable-next-line react-hooks/refs
  const loadTasks = useMemo(() => taskRefresh(readTasks), [readTasks]);

  const loadedDayRef = useRef("");
  useEffect(() => {
    if (!today) return;
    if (loadedDayRef.current && loadedDayRef.current !== today) void loadTasks();
    loadedDayRef.current = today;
  }, [today, loadTasks]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadTasks(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadTasks]);

  const toggleTask = async (task: Task) => {
    if (task.done) return;
    const completedDay = classroomTodoWindow().day;
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, done: true, completedDay } : item));
    if (task.source === "ticktick" && task.projectId) {
      try {
        const response = await fetch("/api/ticktick/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: task.projectId, taskId: task.id }),
        });
        if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || "完成状态没有同步成功"); }
        if (response.status !== 204) {
          const result = await response.json().catch(() => null);
          if (result?.workflow && result.workflow.status !== 'done') throw new Error('请在任务板完成提交与确认');
        }
      } catch (error) {
        setTasks((current) => current.map((item) => item.id === task.id ? { ...item, done: false } : item));
        setSyncError(error instanceof Error ? error.message : "完成状态没有同步成功");
      }
    }
  };

  const connectTickTick = async (event: FormEvent) => {
    event.preventDefault();
    setSyncError("");
    const response = await fetch("/api/ticktick/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token.trim() }),
    });
    if (!response.ok) {
      setSyncError("Token 无效或滴答接口暂时不可用");
      return;
    }
    setToken("");
    taskLoadVersionRef.current++;
    const loaded = await loadTasks(true);
    if (loaded) setSyncOpen(false);
  };

  const disconnectTickTick = async () => {
    const response = await fetch("/api/ticktick/token", { method: "DELETE" });
    if (!response.ok) return;
    taskLoadVersionRef.current++;
    setSyncing(false);
    setConnected(false);
    setTasks((current) => current.filter((task) => task.source === "local"));
    setSyncOpen(false);
  };
  return { tasks, syncOpen, setSyncOpen, connected, syncing, syncError, token, setToken, tasksRef, loadTasks, toggleTask, connectTickTick, disconnectTickTick };
}
