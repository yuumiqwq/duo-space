import { randomUUID } from 'node:crypto';

type Runtime = { instanceId: string; active: boolean; lastRunAt: number | null; running: boolean; scheduler?: ReturnType<typeof createTaskScheduler> };
const shared = globalThis as typeof globalThis & { taskSyncRuntime?: Runtime };
export const taskSyncRuntime = shared.taskSyncRuntime ||= { instanceId: randomUUID(), active: false, lastRunAt: null, running: false };

export function createTaskScheduler(work: () => Promise<void>, isActive: () => Promise<boolean>, interval = 15000, onError: () => void = () => console.error('task-scheduler: tick failed')) {
  let timer: ReturnType<typeof setTimeout> | undefined, pending: Promise<void> | undefined, stopped = true;
  function tick() {
    if (pending) return pending;
    pending = (async () => {
      taskSyncRuntime.active = await isActive();
      if (!taskSyncRuntime.active) return;
      taskSyncRuntime.running = true;
      try { await work(); taskSyncRuntime.lastRunAt = Date.now(); }
      finally { taskSyncRuntime.running = false; }
    })().catch(() => { taskSyncRuntime.active = false; onError(); }).finally(() => { pending = undefined; });
    return pending;
  }
  const schedule = () => { timer = setTimeout(async () => { await tick(); if (!stopped) schedule(); }, interval); timer.unref(); };
  return { tick, start() { if (!stopped) return; stopped = false; schedule(); }, stop() { stopped = true; clearTimeout(timer); } };
}

// A candidate shares /data with production. Check the instance serving the
// public origin before touching the queue; health checks never activate it.
export async function servesTaskSyncOrigin(origin: string, instanceId: string, request: typeof fetch = fetch) {
  const response = await request(new URL('/api/access/runtime', origin), { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) });
  return response.ok && (await response.json()).instanceId === instanceId;
}
export function startTaskScheduler() {
  if (process.env.NODE_ENV !== 'production' || process.env.NEXT_PHASE === 'phase-production-build' || process.env.TASK_SYNC_DISABLED === '1' || taskSyncRuntime.scheduler) return;
  const origin = process.env.TASK_SYNC_ORIGIN || 'https://study.11scat.xyz';
  taskSyncRuntime.scheduler = createTaskScheduler(async () => {
    const { store } = await import('./service');
    await store.maintainWorkflows(true);
  }, () => servesTaskSyncOrigin(origin, taskSyncRuntime.instanceId));
  taskSyncRuntime.scheduler.start();
}
