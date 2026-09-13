import type { CollaborationSnapshot } from './collaboration-types';
import { withoutDeletedWorkflowTasks } from './collaboration-snapshot.ts';
import { readTaskResponse, taskErrorMessage } from './task-request.ts';

export function mergeCollaborationSnapshot(current: CollaborationSnapshot | null, incoming: CollaborationSnapshot, memberId?: string): CollaborationSnapshot {
  if (!current) return withoutDeletedWorkflowTasks(incoming);
  if (current.identityId !== incoming.identityId) return memberId ? current : withoutDeletedWorkflowTasks(incoming);
  const fresh = incoming.revision >= current.revision;
  if (!memberId) {
    if (!fresh) return current;
    return withoutDeletedWorkflowTasks({ ...incoming, members: incoming.members.map(member => {
      const previous = current.members.find(item => item.id === member.id);
      return member.loading && previous?.connected ? { ...previous, name: member.name } : member;
    }) });
  }
  const member = incoming.members.find(item => item.id === memberId);
  return withoutDeletedWorkflowTasks({ ...(fresh ? incoming : current), members: current.members.map(item => item.id === memberId && member
    ? { ...member, loading: false, tasks: member.connected && member.error ? item.tasks : member.tasks }
    : item) });
}

// Return website records as soon as they arrive. Each inbox updates independently;
// a slow member must not delay opening a workflow or acknowledging a command.
export async function loadCollaborationSnapshot({ signal, accept, settled, request = fetch }: {
  signal: AbortSignal;
  accept: (snapshot: CollaborationSnapshot, memberId?: string) => void;
  settled: () => void;
  request?: typeof fetch;
}): Promise<CollaborationSnapshot> {
  async function read(query: string, timeout: number) {
    const response = await request(`/api/room/tasks?${query}`, { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
    const data = await readTaskResponse(response, '协作区读取失败');
    if (!Array.isArray(data.buffer) || !Array.isArray(data.members) || !Array.isArray(data.workflows)) throw new Error('协作区读取失败');
    return data as CollaborationSnapshot;
  }
  let local: CollaborationSnapshot;
  try { local = await read('local=1', 8000); signal.throwIfAborted(); accept(local); }
  catch (error) { settled(); throw error; }
  void Promise.all(local.members.filter(member => member.connected).map(async member => {
    try {
      const next = await read(`member=${encodeURIComponent(member.id)}`, 35000);
      if (next.identityId !== local.identityId || next.members.length !== 1 || next.members[0].id !== member.id) throw new Error('协作区读取失败');
      if (!signal.aborted) accept(next, member.id);
    } catch (error) {
      if (!signal.aborted) accept({ ...local, members: [{ ...member, loading: false, error: taskErrorMessage(error, '收集箱暂时无法读取'), tasks: [] }] }, member.id);
    }
  })).finally(settled);
  return local;
}
