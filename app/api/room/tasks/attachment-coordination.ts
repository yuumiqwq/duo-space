import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { descriptionAttachments } from '../../../task-description-attachments.ts';

type Lease = { directory: string; active: boolean };
const shared = globalThis as typeof globalThis & {
  taskAttachmentCoordination?: { queues: Map<string, Promise<unknown>>; context: AsyncLocalStorage<Lease> };
};
const coordination = shared.taskAttachmentCoordination ||= { queues: new Map(), context: new AsyncLocalStorage<Lease>() };

// All route bundles share the same reference/cleanup boundary. Re-entry lets a
// cleanup call the attachment store without releasing the reference lock.
export function withAttachmentLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(directory), key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const current = coordination.context.getStore();
  if (current?.active && current.directory === key) return work();
  const result = (coordination.queues.get(key) || Promise.resolve()).then(async () => {
    const lease = { directory: key, active: true };
    try { return await coordination.context.run(lease, work); }
    finally { lease.active = false; }
  });
  const pending = result.catch(() => undefined);
  coordination.queues.set(key, pending);
  void pending.then(() => { if (coordination.queues.get(key) === pending) coordination.queues.delete(key); });
  return result;
}

type ReferenceFields = { content?: string };
type ReferenceReview = { comment?: string; files?: { id: string }[] };
type ReferenceState = {
  buffer: Record<string, { fields: ReferenceFields }>;
  workflows: Record<string, { status: string; fields: ReferenceFields; edit?: { fields: ReferenceFields }; events: ReferenceReview[]; completionRequest?: { review?: ReferenceReview } }>;
  operations: Record<string, { status: string; fields?: ReferenceFields }>;
};
export function attachmentReferences(state: ReferenceState) {
  const descriptions = new Set<string>(), workflowFiles = new Set<string>();
  const content = (value?: string) => descriptionAttachments(value || '').attachments.forEach(file => descriptions.add(file.path));
  const review = (value?: ReferenceReview) => {
    content(value?.comment);
    value?.files?.forEach(file => workflowFiles.add(file.id));
  };
  for (const task of Object.values(state.buffer)) content(task.fields.content);
  for (const workflow of Object.values(state.workflows || {})) {
    if (workflow.status !== 'done') content(workflow.fields.content);
    content(workflow.edit?.fields.content);
    workflow.events.forEach(review);
    review(workflow.completionRequest?.review);
  }
  // Retired move receipts may predate saved task fields. Their migration must
  // still persist, while valid pending requests retain their attachment links.
  for (const operation of Object.values(state.operations)) if (operation.status === 'pending') content(operation.fields?.content);
  return { descriptions, workflowFiles };
}
export async function readAttachmentReferences(directory: string) {
  let state: ReferenceState & { version: number };
  try { state = JSON.parse(await readFile(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ directory, 'room-collaboration.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { descriptions: new Set<string>(), workflowFiles: new Set<string>() }; throw error; }
  if (state.version !== 1 || !state.buffer || !state.operations) throw new Error('协作记录格式异常');
  return attachmentReferences(state);
}
