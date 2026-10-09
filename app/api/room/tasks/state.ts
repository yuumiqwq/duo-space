import type { ClaimWorkflow, OperationView, TaskFields, TaskSource, WorkflowFile } from '../../../collaboration-types';
import type { TaskNoticeState } from '../../../collaboration-notifications.ts';
import type { SettingsIntent } from '../../../task-settings-merge.ts';
import type { DeletionDiagnostic, SyncAttempt, taskSyncEvidence } from './sync-diagnostics.ts';
import { canonical, CollaborationError, type RemoteTask, type SettingsBaseline } from './domain.ts';

// Durable receipts remain separate from the public task and workflow views.
export type BufferTask = {
  fields: TaskFields;
  version: number;
  stagedBy?: string;
  publisherId?: string;
  publishedAt?: number;
  completedAt?: number;
};
export type Creation = { state: 'new' | 'sent' | 'received'; beforeIds?: string[] };
export type AttachmentChange = { actor: string; before: string; after: string; publishBefore?: string };
export type WorkflowSide = 'source' | 'target';
export type ReviewDecision = { comment: string; files: WorkflowFile[] };
export type TaskRecovery = { id: string; creation: Creation; done?: boolean };
export type WorkflowEdit = {
  id: string;
  fields: TaskFields;
  intent?: SettingsIntent;
  rebaseTargets?: boolean;
  attachments?: AttachmentChange;
  summary?: string;
  diagnostics?: SyncAttempt[];
  targets?: {
    owner: string;
    id: string;
    before: string;
    baseline?: SettingsBaseline;
    intent?: SettingsIntent;
    done: boolean;
  }[];
};
export type WorkflowDeletion = {
  id: string;
  done?: WorkflowSide[];
  acknowledged?: Partial<Record<WorkflowSide, { id: string; projectId: string }>>;
};
export type Workflow = ClaimWorkflow & {
  settingsResyncReceipts?: { id: string; signature: string; editId: string }[];
  deletionDiagnostic?: DeletionDiagnostic;
  completionRequest?: { id: string; actor: string; signature: string; review?: ReviewDecision };
  publishedAt?: number;
  missingGeneration?: number;
  restoration?: { id: string; generation: number };
  ownerDeletion?: WorkflowDeletion;
  syncRetryAt?: number;
  syncAttempts?: number;
  reopenReceipt?: { before: RemoteTask; retryAt: number };
  sourceReopenReceipt?: { before: RemoteTask; retryAt: number };
  submittedFields?: { source: TaskFields; target: TaskFields };
  projects?: Partial<Record<WorkflowSide, string>>;
  recovery?: Partial<Record<WorkflowSide, TaskRecovery>>;
  signature: string;
  targetCreation: Creation;
  reviewerCreation?: Creation;
  approval?: {
    targetDone: boolean;
    sourceDone: boolean;
    sourceSent?: boolean;
    targetSent?: boolean;
    repeating?: boolean;
  };
  submitted?: { source: string; target: string };
  edit?: WorkflowEdit;
};
export type Operation = OperationView & {
  signature: string;
  source?: TaskSource;
  fields: TaskFields;
  targetId: string;
  updateBaseline?: SettingsBaseline;
  updateIntent?: SettingsIntent;
  syncIssue?: ClaimWorkflow['syncIssue'];
  resyncReceipts?: { id: string; signature: string }[];
  syncCheck?: {
    at: number;
    current?: ReturnType<typeof taskSyncEvidence>;
    observedVersion?: string;
    differences?: string[];
    outcome: 'matched' | 'different' | 'missing' | 'error';
    error?: string;
    retry?: { at: number; status: OperationView['status']; error: string };
  };
  attachments?: AttachmentChange;
  phase: 'prepared' | 'destination-ready' | 'source-removed';
  creation?: Creation;
};
export type State = {
  version: 1;
  revision: number;
  buffer: Record<string, BufferTask>;
  operations: Record<string, Operation>;
  workflows: Record<string, Workflow>;
  executionPlans?: Record<string, { version: number; receipts: { id: string; signature: string }[] }>;
  notifications?: TaskNoticeState;
  legacyCleanup?: { title: string; message: string }[];
  legacyReset?: boolean;
};

export function mergeStateChanges(before: State, changed: State, latest: State): State {
  const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  // A workflow/task is a consistency boundary: two concurrent commands must
  // never combine a stale stage with a newer execution or deletion decision.
  for (const table of ['workflows', 'buffer', 'operations'] as const) {
    for (const id of new Set([...Object.keys(before[table]), ...Object.keys(changed[table])])) {
      if (!equal(before[table][id], changed[table][id]) && !equal(before[table][id], latest[table][id])) throw new CollaborationError('流程已更新，请刷新后操作');
    }
  }
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const merge = (base: unknown, next: unknown, current: unknown): unknown => {
    if (equal(base, next)) return current;
    if (equal(base, current)) return next;
    if (equal(next, current)) return current;
    if (object(base) && object(next) && object(current)) {
      const result: Record<string, unknown> = {};
      for (const key of new Set([...Object.keys(base), ...Object.keys(next), ...Object.keys(current)])) {
        const value = merge(base[key], next[key], current[key]);
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
    throw new CollaborationError('流程已更新，请刷新后操作');
  };
  const plans = structuredClone(latest.executionPlans || {});
  for (const [id, next] of Object.entries(changed.executionPlans || {})) {
    const base = before.executionPlans?.[id] || { version: 0, receipts: [] };
    if (equal(base, next)) continue;
    const current = plans[id] ||= { version: 0, receipts: [] };
    if (!equal(base.receipts, next.receipts) && current.version !== base.version) throw new CollaborationError('执行安排已更新，请重新安排后保存');
    current.version += next.version - base.version;
    if (!equal(base.receipts, next.receipts)) current.receipts = next.receipts;
  }
  const view = (state: State) => ({ ...state, revision: 0, executionPlans: {}, notifications: { ...state.notifications, version: 0 } });
  const result = { ...merge(view(before), view(changed), view(latest)) as State, executionPlans: plans };
  if (result.notifications) result.notifications.version = (latest.notifications?.version || 0) + (changed.notifications?.version || 0) - (before.notifications?.version || 0);
  return result;
}
