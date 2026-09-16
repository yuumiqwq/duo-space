import type { TaskFields } from './collaboration-types';

export type SettingsIntent = { base: TaskFields; desired: TaskFields };
export const settingGroups: (keyof TaskFields)[][] = [
  ['title'], ['content'], ['priority'], ['tags'], ['kind', 'items', 'desc'],
  ['startDate', 'dueDate', 'isAllDay', 'timeZone', 'reminders', 'repeatFlag', 'repeatFrom'],
];
const date = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export function comparableSettings(fields: TaskFields) {
  const start = date(fields.startDate), due = date(fields.dueDate);
  const single = fields.isAllDay && !fields.repeatFlag && !fields.reminders.length;
  return { ...fields, startDate: single ? start ?? due : start, dueDate: single ? due ?? start : due,
    tags: [...new Set(fields.tags)].sort(), reminders: [...new Set(fields.reminders)].sort(),
    repeatFrom: fields.repeatFlag ? fields.repeatFrom : '',
    items: fields.items.map(item => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'id'))),
  };
}
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
const equal = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

// Untouched groups follow the provider. A touched group can resume only when
// each value is still the original or the requested value (including partial writes).
export function mergeTaskSettings(base: TaskFields, desired: TaskFields, current: TaskFields) {
  const before = comparableSettings(base), requested = comparableSettings(desired), latest = comparableSettings(current);
  const fields = { ...current }, conflicts: (keyof TaskFields)[] = [];
  for (const group of settingGroups) {
    if (group.every(key => equal(before[key], requested[key]))) continue;
    for (const key of group) {
      if (!equal(latest[key], before[key]) && !equal(latest[key], requested[key])) conflicts.push(key);
      if (!equal(before[key], requested[key])) Object.assign(fields, { [key]: desired[key] });
    }
  }
  return { fields, conflicts };
}
