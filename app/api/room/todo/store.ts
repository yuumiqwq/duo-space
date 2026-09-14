import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { classroomTodoWindow, mergeTodoSnapshot, type TodoTask } from '../../../classroom-todo.ts';

export type StoredTodoTask = TodoTask & { project: string; projectId?: string };
type State = { version: 1; members: Record<string, { day: string; tasks: StoredTodoTask[] }> };

export function createTodoStore(directory: string) {
  const file = path.join(directory, 'classroom-todo.json');
  let queue: Promise<unknown> = Promise.resolve();
  async function read(): Promise<State> {
    try { const state = JSON.parse(await readFile(file, 'utf8')); if (state.version !== 1 || !state.members) throw new Error('今日 todo 数据格式无效'); return state; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, members: {} }; throw error; }
  }
  function update<T>(action: (state: State) => T | Promise<T>): Promise<T> {
    const result = queue.then(async () => {
      const state = await read(), result = await action(state);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
      await rename(temp, file);
      return result;
    });
    queue = result.catch(() => undefined);
    return result;
  }
  return {
    reconcile(identity: string, incoming: StoredTodoTask[], now = Date.now(), partial?: { failedProjectIds: string[]; incompleteProjects: boolean; inboxFailed: boolean; readProjectIds: string[] }) {
      return update(state => {
        const day = classroomTodoWindow(now).day;
        const previous = state.members[identity]?.tasks || [];
        const retained = partial ? previous.filter(task => !incoming.some(item => item.id === task.id) && (partial.failedProjectIds.includes(task.projectId || '') || ((partial.incompleteProjects || partial.inboxFailed) && !partial.readProjectIds.includes(task.projectId || '')))) : [];
        const tasks = mergeTodoSnapshot(previous, [...incoming, ...retained], now);
        state.members[identity] = { day, tasks };
        return tasks;
      });
    },
    complete(identity: string, taskId: string, now = Date.now()) {
      return update(state => {
        const day = classroomTodoWindow(now).day;
        const member = state.members[identity];
        if (!member) return;
        member.tasks = member.tasks.map(task => task.id === taskId ? { ...task, done: true, completedDay: day } : task);
      });
    },
  };
}
const directory = process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/data' : path.join(process.cwd(), '.data'));
const shared = globalThis as typeof globalThis & { classroomTodoStore?: ReturnType<typeof createTodoStore> };
// Next bundles completion and list routes separately; share their write queue.
export const todoStore = shared.classroomTodoStore ||= createTodoStore(directory);
