import type { TaskFields } from './collaboration-types';
import { mergeTaskSettings } from './task-settings-merge.ts';

// Rebase only the fields the editor changed; a nudge does not change task fields.
export function rebaseWorkflowDraft(base: TaskFields, draft: TaskFields, latest: TaskFields) {
  const patch: Partial<TaskFields> = {};
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const key of Object.keys(draft) as (keyof TaskFields)[]) {
    if (equal(base[key], draft[key])) continue;
    Object.assign(patch, { [key]: draft[key] });
  }
  return { patch, conflicts: mergeTaskSettings(base, draft, latest).conflicts };
}
