"use client";

import { useState } from "react";
import { ArrowLeft, Check, Trash2 } from "lucide-react";
import type { CollaborationCommand, RoomTask } from "./collaboration-types";
import { TaskDescription } from "./TaskDescription";
import { TaskSettings } from "./WorkflowSettings";
import { taskErrorMessage } from "./task-request";

export function UnclaimedTaskDetail({ task, identityId, name, busy, error, perform, back }: { task: RoomTask; identityId: string; name: (id: string) => string; busy: boolean; error: string; perform: (command: CollaborationCommand) => Promise<boolean>; back: () => void }) {
  const [deleteArmed, setDeleteArmed] = useState(false);
  const reviewerId = task.ownerId || task.publisherId;
  const disabled = busy || !!task.pending;
  const source = { ownerId: task.ownerId, taskId: task.id, version: task.version };
  async function remove() {
    if (!deleteArmed) { setDeleteArmed(true); return; }
    if (await perform({ id: crypto.randomUUID(), action: "delete", source })) back();
  }
  return <div className="coop-workflow-detail">
    <section className="coop-workflow-main" aria-label="任务内容及操作">
      <button type="button" className="coop-workflow-back" disabled={busy} onClick={back}><ArrowLeft size={15} />返回列表</button>
      <div className="coop-workflow-heading"><h4>{task.title}</h4><div className="coop-workflow-actions">
        {reviewerId === identityId && <button type="button" disabled={disabled} onClick={async () => { if (await perform({ id: crypto.randomUUID(), action: "complete", source })) back(); }}><Check size={15} />直接完成</button>}
      </div></div>
      {task.content && <TaskDescription content={task.content} />}
      <p className="coop-workflow-people">{reviewerId ? name(reviewerId) : "成员"} 审批</p>
      <ol className="coop-workflow-events" />
      {error && <p className="coop-feedback error" role="alert">{taskErrorMessage(error)}</p>}
    </section>
    <TaskSettings taskKey={`${task.ownerId || "buffer"}:${task.id}`} currentFields={task} disabled={disabled}
      save={fields => perform({ id: crypto.randomUUID(), action: "update", source, fields })}
      deletion={locked => <div className="workflow-task-deletion"><div className="coop-workflow-actions"><button type="button" className={deleteArmed ? "coop-delete workflow-delete-confirm" : "coop-delete workflow-delete-icon"} aria-label={deleteArmed ? "确认删除" : "删除任务"} disabled={locked} onClick={() => void remove()}>{deleteArmed ? "确认删除" : <Trash2 size={19} aria-hidden="true" />}</button></div></div>} />
  </div>;
}
