import { classroomDay } from './classroom-view.ts';

const DAY = 86_400_000;
export type TodoTask = { id: string; title: string; startDate?: string; dueDate?: string; isAllDay?: boolean; done: boolean; completedDay?: string };
export function classroomTodoWindow(now: Date | number = Date.now()) {
  const time = Number(now);
  const todaySix = Date.parse(`${classroomDay(time)}T06:00:00+08:00`);
  const start = time >= todaySix ? todaySix : todaySix - DAY;
  return { day: classroomDay(start), start, end: start + DAY, next: start + DAY };
}
export function todoDueTime(task: Pick<TodoTask, 'startDate' | 'dueDate' | 'isAllDay'>) {
  const times = [task.startDate, task.dueDate].map(date => {
    if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return NaN;
    if (date.length === 10) return Date.parse(`${date}T23:59:59.999+08:00`);
    const time = Date.parse(date);
    if (!Number.isFinite(time)) return NaN;
    // Timestamp forms can be UTC even for an all-day task. Resolve the room's
    // calendar date before assigning its end of day, matching task-board dates.
    return task.isAllDay ? Date.parse(`${classroomDay(time)}T23:59:59.999+08:00`) : time;
  }).filter(Number.isFinite);
  return times.length ? Math.max(...times) : NaN;
}
export function classroomTodoTasks<T extends TodoTask>(tasks: T[], now: Date | number = Date.now()): T[] {
  const window = classroomTodoWindow(now);
  const midnight = Date.parse(`${window.day}T00:00:00+08:00`) + DAY;
  return tasks.filter(task => {
    const due = todoDueTime(task);
    const allDay = task.isAllDay || [task.startDate, task.dueDate].some(date => date?.length === 10);
    if (!Number.isFinite(due) || due >= (allDay ? midnight : window.end)) return false;
    // Unfinished work carries over. A carried task checked in this room day
    // remains visible until the next 06:00, just like today's completed tasks.
    return !task.done || due >= window.start || task.completedDay === window.day;
  });
}
export function mergeTodoSnapshot<T extends TodoTask>(previous: T[], incoming: T[], now = Date.now()): T[] {
  const done = classroomTodoTasks(previous.filter(task => task.done), now);
  const selected = classroomTodoTasks(incoming, now);
  // The same id with a new date can be a recurring task's next occurrence.
  const current = selected.map(task => {
    const checked = done.find(old => old.id === task.id && todoDueTime(old) === todoDueTime(task));
    return checked ? { ...task, done: true, completedDay: checked.completedDay } : task;
  });
  return [...current, ...done.filter(old => !current.some(task => task.id === old.id))];
}
