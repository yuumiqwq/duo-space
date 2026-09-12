export type TaskFields = {
  title: string; content: string; priority: 0 | 1 | 3 | 5;
  startDate: string | null; dueDate: string | null; isAllDay: boolean; timeZone: string;
  tags: string[]; reminders: string[]; repeatFlag: string; repeatFrom: string; desc: string; kind: string; items: Record<string, unknown>[];
};
export type RoomTask = TaskFields & { id: string; ownerId: string | null; version: string; pending?: string; transferBlocked?: string; workflowId?: string; publisherId?: string };
export type CollaborationMember = { id: string; name: string; connected: boolean; loading?: boolean; error?: string; diagnostic?: string; tasks: RoomTask[] };
export type OperationView = { id: string; actorId: string; title: string; action: string; from: string | null; to: string | null; status: "pending" | "done" | "cancelled"; error: string; createdAt?: number; updatedAt: number };
export type WorkflowFile = { id: string; name: string; size: number; url: string };
export type WorkflowEvent = { id: string; actorId: string; type: string; at: number; comment: string; files: WorkflowFile[]; signature?: string; replyTo?: string };
export type ClaimWorkflow = {
  id: string; title: string; source: TaskSource; reviewerId: string; claimantId: string;
  targetId: string; reviewerTaskId?: string; fields: TaskFields;
  status: "creating" | "working" | "submitted" | "rejected" | "approving" | "done" | "deleted";
  version: number; createdAt: number; updatedAt: number; error: string; events: WorkflowEvent[];
  editPending?: boolean;
  ownerDeletePending?: boolean;
  taskAnomaly?: boolean;
  syncError?: string;
  reopenPending?: boolean;
  needsSubmission?: boolean;
};
export type WorkflowCommand = { id: string; workflowId: string; version: number; action: "submit" | "approve" | "reject" | "retry-workflow" | "owner-complete" | "update-workflow" | "restore-workflow" | "delete-claimed-task" | "delete-owner-task" | "nudge" | "reply-nudge"; comment?: string; replyTo?: string; attachments?: string[]; fields?: Partial<TaskFields> };
export type CollaborationSnapshot = { identityId: string; revision: number; noticeVersion?: number; buffer: RoomTask[]; members: CollaborationMember[]; operations: OperationView[]; workflows: ClaimWorkflow[]; legacyCleanup?: { title: string; message: string }[]; notices?: import("./collaboration-notifications").TaskNotice[] };
export type TaskSource = { ownerId: string | null; taskId: string; version: string };
export type CollaborationCommand = { id: string; action: "create" | "update" | "move" | "claim" | "complete" | "delete"; source?: TaskSource; destination?: string | null; fields?: Partial<TaskFields>; dateAfter?: TaskSource };
