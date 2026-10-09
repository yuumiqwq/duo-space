import { randomUUID } from 'node:crypto';
import type { ClaimWorkflow } from '../../../collaboration-types';
import { mergeTaskSettings } from '../../../task-settings-merge.ts';
import { CollaborationError, canResumeSettings, fieldDifferences, mergedSettings, remoteVersion, sameFields, taskFields, type RemoteTask } from './domain.ts';
import type { Gateway } from './gateway.ts';
import type { AttachmentChange, State, Workflow, WorkflowSide } from './state.ts';
import { appendSyncAttempt, taskSyncEvidence, type SyncAttempt } from './sync-diagnostics.ts';

// Settings synchronization owns provider comparisons and resumable edit progress.
// State publication and workflow stage transitions remain with the coordinator.
export type WorkflowSettingsContext = {
  gateway: Gateway;
  linkedTask(state: State, workflow: Workflow, side: WorkflowSide): Promise<RemoteTask | null>;
  saveWorkflow(state: State, workflow: Workflow): Promise<void>;
  startWorkflow(state: State, workflow: Workflow, completing: boolean): Promise<ClaimWorkflow>;
  workflowSides(state: State, workflow: Workflow): Promise<{ source: RemoteTask | null; target: RemoteTask }>;
  markMissingWorkflowTask(state: State, workflow: Workflow): Promise<void>;
  cleanAttachments(change: AttachmentChange): Promise<void>;
  publicWorkflow(workflow: Workflow): ClaimWorkflow;
};

async function syncWorkflowIntent(context: WorkflowSettingsContext, state: State, workflow: Workflow, attempt: SyncAttempt) {
  const edit = workflow.edit!, intent = edit.intent!;
  let desired = intent.desired;
  // Reconcile all copies before writing any, so an unrelated edit on either
  // side is retained and competing edits to the same setting are not guessed.
  for (const target of edit.targets!) {
    const side = target.owner === workflow.claimantId && target.id === workflow.targetId ? 'target' : 'source';
    const task = await context.linkedTask(state, workflow, side);
    if (!task && side === 'source' && !workflow.source.ownerId) continue;
    if (!task) throw new CollaborationError('该任务已被删除');
    if (!target.baseline || (task.status || 0) !== target.baseline.status || (task.parentId || '') !== target.baseline.parentId) throw new CollaborationError('关联任务在同步期间被修改，已暂停覆盖，请核对后重试');
    attempt.stage = 'compare-version';
    attempt.target = { owner: target.owner, id: target.id, expectedVersion: target.before, observedVersion: remoteVersion(task), differences: fieldDifferences(task, desired), current: taskSyncEvidence(task) };
    const candidate = mergedSettings(target.intent || intent, taskFields(task));
    desired = mergedSettings({ base: intent.base, desired }, candidate);
  }
  edit.fields = desired;
  if (edit.attachments) edit.attachments.after = desired.content;
  await context.saveWorkflow(state, workflow);
  for (const target of edit.targets!) {
    const side = target.owner === workflow.claimantId && target.id === workflow.targetId ? 'target' : 'source';
    const task = await context.linkedTask(state, workflow, side);
    if (!task && side === 'source' && !workflow.source.ownerId) continue;
    if (!task) throw new CollaborationError('该任务已被删除');
    if (!target.baseline || (task.status || 0) !== target.baseline.status || (task.parentId || '') !== target.baseline.parentId) throw new CollaborationError('关联任务在同步期间被修改，已暂停覆盖，请核对后重试');
    // The previous side may have taken long enough for this copy to change.
    // Re-merge against its current fields, keeping same-group conflicts paused.
    desired = mergedSettings({ base: intent.base, desired }, mergedSettings(target.intent || intent, taskFields(task)));
    edit.fields = desired;
    if (edit.attachments) edit.attachments.after = desired.content;
    attempt.target = { owner: target.owner, id: target.id, expectedVersion: target.before, observedVersion: remoteVersion(task), differences: fieldDifferences(task, desired), current: taskSyncEvidence(task) };
    if (!sameFields(task, desired)) {
      attempt.stage = 'write-linked-task'; target.before = remoteVersion(task);
      await context.saveWorkflow(state, workflow);
      const saved = await context.gateway.update(target.owner, target.id, desired, target.before, workflow.projects?.[side], task) || await context.linkedTask(state, workflow, side);
      if (saved) desired = mergedSettings({ base: intent.base, desired }, taskFields(saved));
    }
    target.done = true;
    await context.saveWorkflow(state, workflow);
  }
  // The provider can retain a concurrent change to an untouched field during
  // its bounded retry. A following pass propagates it to other linked copies.
  edit.fields = desired;
  if (mergeTaskSettings(intent.base, intent.desired, edit.fields).conflicts.length || !sameFields(mergedSettings(intent, edit.fields), edit.fields)) throw new CollaborationError('关联任务详情暂未一致，请核对后重试');
  if (edit.attachments) edit.attachments.after = edit.fields.content;
}
export async function finishWorkflowSettings(context: WorkflowSettingsContext, state: State, workflow: Workflow, completing = false) {
  const edit = workflow.edit!;
  const attempt: SyncAttempt = { id: randomUUID(), editId: edit.id, at: Date.now(), stage: 'publish-attachments', requested: taskSyncEvidence(edit.fields) };
  edit.diagnostics = appendSyncAttempt(edit.diagnostics || [], attempt);
  await context.saveWorkflow(state, workflow);
  try {
    if (edit.attachments) await context.gateway.taskAttachments?.publish(edit.attachments.actor, edit.attachments.publishBefore ?? edit.attachments.before, edit.attachments.after);
    attempt.stage = 'locate-linked-tasks';
    if (workflow.status === "creating") {
      await context.startWorkflow(state, workflow, completing);
      if (workflow.status === "creating") {
        attempt.error = workflow.error; attempt.finishedAt = Date.now();
        await context.saveWorkflow(state, workflow); return context.publicWorkflow(workflow);
      }
    }
    if (!edit.targets) {
      const sides = await context.workflowSides(state, workflow);
      const target = (owner: string, task: RemoteTask) => ({ owner, id: task.id, before: remoteVersion(task), baseline: { fields: taskFields(task), status: task.status || 0, parentId: task.parentId || '' },
        ...(edit.rebaseTargets && edit.intent ? { intent: { base: taskFields(task), desired: mergeTaskSettings(edit.intent.base, edit.intent.desired, taskFields(task)).fields } } : {}), done: false });
      edit.targets = sides.source ? [target(workflow.reviewerId, sides.source)] : [];
      if (workflow.claimantId !== workflow.reviewerId || workflow.targetId !== edit.targets[0]?.id) edit.targets.push(target(workflow.claimantId, sides.target));
      await context.saveWorkflow(state, workflow);
    }
    if (edit.intent) await syncWorkflowIntent(context, state, workflow, attempt);
    else for (const target of edit.targets) {
      if (target.done) continue;
      const side = target.owner === workflow.reviewerId ? "source" : "target";
      const task = await context.linkedTask(state, workflow, side);
      if (!task && side === "source") { target.done = true; await context.saveWorkflow(state, workflow); continue; }
      if (!task) { await context.markMissingWorkflowTask(state, workflow); throw new CollaborationError("该任务已被删除"); }
      attempt.stage = 'compare-version';
      attempt.target = { owner: target.owner, id: target.id, expectedVersion: target.before, observedVersion: remoteVersion(task), differences: fieldDifferences(task, edit.fields), current: taskSyncEvidence(task) };
      if (!sameFields(task, edit.fields)) {
        if (remoteVersion(task) !== target.before) {
          // A changed etag or our partially applied write can safely resume
          // only while every field still equals its saved before/desired value.
          if (!canResumeSettings(task, edit.fields, target.baseline)) throw new CollaborationError("关联任务在同步期间被修改，已暂停覆盖，请核对后重试");
          target.before = remoteVersion(task); attempt.versionRefreshed = true;
        }
        attempt.stage = 'write-linked-task';
        await context.saveWorkflow(state, workflow);
        await context.gateway.update(target.owner, target.id, edit.fields, target.before, workflow.projects?.[side], task);
      }
      target.done = true; await context.saveWorkflow(state, workflow);
    }
    attempt.stage = 'verify-linked-tasks';
    const sides = {
      source: await context.linkedTask(state, workflow, 'source'),
      target: await context.linkedTask(state, workflow, 'target'),
    };
    if (!sides.target) throw new CollaborationError('该任务已被删除');
    if ((sides.source && !sameFields(sides.source, edit.fields)) || !sameFields(sides.target, edit.fields)) throw new CollaborationError("关联任务详情暂未一致，请核对后重试");
    if (workflow.source.ownerId === null && state.buffer[workflow.source.taskId]) {
      const task = state.buffer[workflow.source.taskId];
      task.fields = edit.fields; task.version++;
    }
    if (workflow.approval) workflow.approval.repeating ||= !!workflow.fields.repeatFlag;
    workflow.fields = edit.fields; workflow.title = edit.fields.title;
    // Editing task details preserves pending review. Only an explicit reject
    // asks the claimant to submit again.
    if (workflow.reopenReceipt) {
      if (sides.target.status === 2) workflow.reopenReceipt = { before: sides.target, retryAt: 0 };
      else if (!sides.target.status) { delete workflow.reopenReceipt; workflow.reopenPending = false; }
    }
    // Explicit edits during partially completed approval update the expected fields,
    // but preserve acknowledged/sent completion markers, including repeating tasks.
    if (workflow.status === "approving") workflow.submitted = { source: sides.source ? remoteVersion(sides.source) : "", target: remoteVersion(sides.target) };
    attempt.stage = 'clean-attachments';
    if (edit.attachments) { await context.saveWorkflow(state, workflow); await context.cleanAttachments(edit.attachments); }
    delete workflow.edit; workflow.error = "";
  } catch (error) {
    workflow.error = error instanceof Error ? error.message : "任务详情尚未同步完成，请重试";
    attempt.error = workflow.error;
    if (error instanceof CollaborationError && error.diagnostic) attempt.provider = error.diagnostic;
  }
  attempt.finishedAt = Date.now();
  await context.saveWorkflow(state, workflow); return context.publicWorkflow(workflow);
}
