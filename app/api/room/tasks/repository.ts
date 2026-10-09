import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeStoreFile } from '../../store-file.ts';
import { collectTaskNotices, initializeTaskNotices, workflowEventPresentation } from '../../../collaboration-notifications.ts';
import { attachmentReferences, withAttachmentLock } from './attachment-coordination.ts';
import { CollaborationError, isPersonalCollection } from './domain.ts';
import { mergeStateChanges, type BufferTask, type Operation, type State, type Workflow } from './state.ts';
import type { FileMetadata } from './files/storage.ts';

// Owns migrations and the short atomic commit. Provider calls stay in the service
// so an interrupted network request never holds the attachment/reference lock.
export class CollaborationRepository {
  private baselines = new WeakMap<State, State>();
  private file: string;
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
    this.file = path.join(/* turbopackIgnore: true */ directory, 'room-collaboration.json');
  }

  async read(): Promise<State> {
    try {
      const state = JSON.parse(await readFile(/* turbopackIgnore: true */ this.file, "utf8"));
      if (state.version !== 1 || !state.buffer || !state.operations) throw new Error("协作记录格式异常");
      state.workflows ||= {};
      // An accepted whole-task deletion removes the public card immediately,
      // even while linked inbox deletions are waiting for provider confirmation.
      // Old one-sided deletion receipts do not authorize removing another copy.
      for (const workflow of Object.values(state.workflows) as Workflow[]) {
        // Initialize existing claims once. Pending submissions retain their
        // execution slot and review history; ordinary claims start unarranged.
        workflow.events = workflow.events.map(event => workflowEventPresentation(event, event.id === workflow.edit?.id ? workflow.edit?.summary : undefined));
        // Public tasks without a claimant have no workflow and are untouched.
        workflow.executing ??= !isPersonalCollection(workflow) && !workflow.ownerDeletion && (workflow.status === 'submitted' || (workflow.status === 'approving' && workflow.events.some(event => event.type === 'submit')));
        const deleting = workflow.ownerDeletion && workflow.events.some(event => event.id === workflow.ownerDeletion?.id && event.type === 'task-delete-requested');
        if ((workflow.status === 'deleted' || deleting) && workflow.source.ownerId === null) delete state.buffer[workflow.source.taskId];
      }
      for (const [id, task] of Object.entries(state.buffer) as [string, BufferTask][]) {
        const publication = (Object.values(state.operations) as Operation[]).find(op => op.action === "create" && op.targetId === id);
        task.publisherId ||= publication?.actorId;
        task.publishedAt ??= publication?.createdAt;
      }
      initializeTaskNotices(state); this.baselines.set(state, structuredClone(state)); return state;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.emptyState(); throw error; }
  }
  private emptyState(): State {
    const state: State = { version: 1, revision: 0, buffer: {}, operations: {}, workflows: {}, notifications: { known: [], entries: [], read: {}, attempted: [] } };
    this.baselines.set(state, structuredClone(state)); return state;
  }
  write(state: State) {
    return withAttachmentLock(path.dirname(this.file), async () => {
      const before = this.baselines.get(state);
      if (!before) throw new CollaborationError('流程已更新，请刷新后操作');
      const latest = await this.read();
      const merged = mergeStateChanges(before, state, latest);
      const existingFiles = attachmentReferences(latest).workflowFiles;
      const nextFiles = attachmentReferences(merged).workflowFiles;
      for (const id of nextFiles) if (!existingFiles.has(id)) {
        // A draft may expire while a command reads its metadata. Validate its
        // continued existence in the same boundary that persists the reference.
        await readFile(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ path.dirname(this.file), 'workflow-files', `${id}.json`)).catch(() => { throw new CollaborationError('附件不存在，请重新上传', 400); });
      }
      for (const id of existingFiles) if (!nextFiles.has(id)) {
        // Even a superseded durable approval decision has submitted materials.
        // Retain them before retiring its last reference from the active state.
        const location = path.join(/* turbopackIgnore: true */ path.dirname(this.file), 'workflow-files', `${id}.json`);
        const contents = await readFile(/* turbopackIgnore: true */ location, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!contents) continue;
        const metadata = JSON.parse(contents);
        await writeStoreFile(location, JSON.stringify({ ...metadata, retained: true }));
      }
      merged.revision = latest.revision + Math.max(0, state.revision - before.revision);
      for (const workflow of Object.values(merged.workflows)) {
        const message = workflow.syncError || workflow.error;
        if (message && message !== '该任务已被删除' && !isPersonalCollection(workflow)) {
          if (!workflow.syncIssue) {
            const actor = workflow.events.find(event => event.id === workflow.edit?.id)?.actorId || workflow.completionRequest?.actor || workflow.events.findLast(event => event.actorId)?.actorId || workflow.reviewerId;
            workflow.syncIssue = { id: randomUUID(), message, at: Date.now(), recipientId: actor };
          } else workflow.syncIssue.message = message;
        } else if (workflow.syncIssue) {
          delete workflow.syncIssue;
          const notices = initializeTaskNotices(merged); notices.version = (notices.version || 0) + 1;
        }
      }
      for (const op of Object.values(merged.operations)) {
        if (op.action === 'update' && op.status === 'pending' && op.error) {
          op.syncIssue ||= { id: randomUUID(), at: Date.now(), message: op.error, recipientId: op.actorId };
          op.syncIssue.message = op.error;
        } else if (op.syncIssue) {
          delete op.syncIssue;
          const notices = initializeTaskNotices(merged); notices.version = (notices.version || 0) + 1;
        }
      }
      collectTaskNotices(merged);
      await writeStoreFile(this.file, JSON.stringify(merged));
      state.revision = merged.revision;
      // Carry generated incident identities into subsequent saves of this command.
      for (const [id, workflow] of Object.entries(state.workflows)) {
        if (merged.workflows[id]?.syncIssue) workflow.syncIssue = structuredClone(merged.workflows[id].syncIssue);
        else delete workflow.syncIssue;
      }
      for (const [id, op] of Object.entries(state.operations)) {
        if (merged.operations[id]?.syncIssue) op.syncIssue = structuredClone(merged.operations[id].syncIssue);
        else delete op.syncIssue;
      }
      this.baselines.set(state, structuredClone(state));
    });
  }

  async workflowFile(id: string): Promise<FileMetadata> {
    const location = path.join(/* turbopackIgnore: true */ this.directory, 'workflow-files', `${id}.json`);
    const contents = await readFile(/* turbopackIgnore: true */ location, 'utf8').catch(() => { throw new CollaborationError('附件不存在，请重新上传', 400); });
    return JSON.parse(contents);
  }
}
