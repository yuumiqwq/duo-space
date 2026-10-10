import type { WorkflowEvent } from "./collaboration-types";
import { attachmentDisplayText } from "./task-description-attachments";
import { parseWorkflowSettingChanges } from "./workflow-setting-changes";

export function WorkflowEventComment({ event }: { event: WorkflowEvent }) {
  const changes = event.type === "updated" ? event.settingChanges ?? parseWorkflowSettingChanges(event.comment) : null;
  if (!changes?.length) return event.comment ? <p>{attachmentDisplayText(event.comment)}</p> : null;
  return <section className="workflow-setting-changes">
    {changes.map((change, index) => {
      const stacked = change.field === "content" || [change.before, change.after].some(value => value.length > 80 || /[\r\n]/.test(value));
      return <section className="workflow-setting-change" key={`${change.field}-${index}`} aria-label={change.label}>
        <strong className="workflow-setting-label">{change.label}</strong>
        <div className={`workflow-setting-comparison${stacked ? " is-stacked" : ""}`}>
          <p className="workflow-setting-value" aria-label={`${change.label}修改前`}>{attachmentDisplayText(change.before)}</p>
          <span className="workflow-setting-arrow" aria-hidden="true">→</span>
          <p className="workflow-setting-value is-after" aria-label={`${change.label}修改后`}>{attachmentDisplayText(change.after)}</p>
        </div>
      </section>;
    })}
  </section>;
}
