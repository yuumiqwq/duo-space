import type { TaskNotice } from '../../../collaboration-notifications.ts';
import type { TaskFields } from '../../../collaboration-types';
import type { RemoteTask } from './domain.ts';

export type Gateway = {
  members(): Promise<{ id: string; name: string; connected: boolean }[]>;
  inbox(owner: string): Promise<{ projectId: string; tasks: RemoteTask[] }>;
  resolveInbox?(owner: string, inbox: { projectId: string; tasks: RemoteTask[] }): Promise<{ projectId: string; tasks: RemoteTask[] }>;
  get(owner: string, id: string, projectId?: string): Promise<RemoteTask | null>;
  locate?(owner: string, id: string, projectId?: string, completedAfter?: number): Promise<RemoteTask | null>;
  notify?(notice: TaskNotice): Promise<void>;
  taskAttachments?: { publish(actor: string, before: string, after: string): Promise<void>; remove(files: string[]): Promise<void> };
  cleanupWorkflowFiles?(): Promise<unknown>;
  create(owner: string, id: string, fields: TaskFields, receipt?: (actualId: string) => Promise<void>, prepared?: { projectId: string; tasks: RemoteTask[] }): Promise<RemoteTask | void>;
  update(owner: string, id: string, fields: TaskFields, version: string, projectId?: string, before?: RemoteTask): Promise<RemoteTask | void>;
  // A missing project/task route is distinct from a positive DELETE response.
  remove(owner: string, id: string, projectId?: string): Promise<void | "missing">;
  complete(owner: string, id: string, projectId?: string): Promise<void>;
  reopen(owner: string, before: RemoteTask, completedAfter?: number): Promise<RemoteTask>;
  checkTransfer(owner: string, task: RemoteTask): Promise<void>;
};
