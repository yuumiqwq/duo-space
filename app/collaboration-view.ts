type DatedTask = { dueDate: string | null; startDate: string | null };

const pinColors = ['#d75c4c', '#dbac40', '#4c91bd', '#4e9d79', '#ad78b5'] as const;
/** Task IDs are random at creation; deriving the color from the ID keeps it stable across viewers and reloads. */
export function collaborationPinColor(id: string): string {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return pinColors[(hash >>> 0) % pinColors.length];
}

/** Move the displayed date onto the preceding task's Shanghai day, retaining times and duration. */
export function collaborationDateAfter(task: DatedTask, previous: DatedTask): Partial<DatedTask> {
  const preceding = collaborationDate(previous);
  if (!preceding) return {};
  const day = (value: string) => Math.floor((Date.parse(value) + 8 * 3600000) / 86400000);
  const current = collaborationDate(task);
  if (!current) return { dueDate: new Date(day(preceding) * 86400000 - 8 * 3600000).toISOString() };
  const shift = (day(preceding) - day(current)) * 86400000;
  if (!shift) return {};
  return Object.fromEntries((["startDate", "dueDate"] as const)
    .filter(key => task[key] && Number.isFinite(Date.parse(task[key]!)))
    .map(key => [key, new Date(Date.parse(task[key]!) + shift).toISOString()]));
}

// Match the task board: deadline first, otherwise the scheduled start.
export function collaborationDate(task: DatedTask): string | null {
  return [task.dueDate, task.startDate].find(date => date && Number.isFinite(Date.parse(date))) || null;
}

export function splitCollaborationTasks<T extends DatedTask>(tasks: readonly T[]): { dated: T[]; undated: T[] } {
  const dated: T[] = [], undated: T[] = [];
  for (const task of tasks) (collaborationDate(task) ? dated : undated).push(task);
  dated.sort((a, b) => Date.parse(collaborationDate(a)!) - Date.parse(collaborationDate(b)!));
  return { dated, undated };
}

/** Calendar labels follow Shanghai dates and Monday-based calendar weeks. */
export function collaborationDateLabel(task: DatedTask & { isAllDay: boolean }, now = new Date()): string {
  const value = collaborationDate(task);
  if (!value) return "";
  const date = new Date(value);
  const localDay = (value: Date) => Math.floor((value.getTime() + 8 * 3600000) / 86400000);
  const today = localDay(now), target = localDay(date), delta = target - today;
  if (task.isAllDay ? delta < 0 : date.getTime() < now.getTime()) return "已过期";
  const weekday = (day: number) => (day + 3) % 7;
  const weekStart = today - weekday(today);
  let label: string;
  if (delta >= 0 && delta <= 3) label = ["今天", "明天", "后天", "大后天"][delta];
  else if (target >= weekStart && target < weekStart + 14) label = `${target < weekStart + 7 ? "这周" : "下周"}${["一", "二", "三", "四", "五", "六", "日"][weekday(target)]}`;
  else label = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).format(date);
  return task.isAllDay ? label : `${label} ${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date)}`;
}
