// Task editors display and submit dates in the room's fixed UTC+8 timezone.
import type { TaskFields } from './collaboration-types';

type TaskDates = Pick<TaskFields, 'startDate' | 'dueDate' | 'isAllDay'>;
export const dateInput = (date: string | null, allDay: boolean) => date ? new Date(Date.parse(date) + 8 * 3600000).toISOString().slice(0, allDay ? 10 : 16) : "";
export const apiDate = (text: string, allDay: boolean, end = false) => text ? `${text}${allDay ? end ? "T23:59:00" : "T00:00:00" : ":00"}+0800` : null;

export function allDaySelection<T extends TaskDates>(fields: T): T {
  if (!fields.isAllDay || (!!fields.startDate === !!fields.dueDate)) return fields;
  const date = fields.startDate || fields.dueDate;
  return { ...fields, startDate: date, dueDate: date };
}

export function taskDateInputs(fields: TaskDates) {
  const start = dateInput(fields.startDate, fields.isAllDay), due = dateInput(fields.dueDate, fields.isAllDay);
  if (fields.isAllDay && (start || due) && (!start || !due || start === due)) return { start: start || due, due: '' };
  return { start, due };
}

export function taskDateSelection(fields: TaskDates, start: string, due: string) {
  const previous = taskDateInputs(fields);
  // Opening an existing task or editing its title must retain its raw dates.
  if (start === previous.start && due === previous.due) return { startDate: fields.startDate, dueDate: fields.dueDate };
  if (fields.isAllDay && (start || due) && (!start || !due || start === due)) {
    const date = apiDate(start || due, true);
    return { startDate: date, dueDate: date };
  }
  return {
    startDate: start === dateInput(fields.startDate, fields.isAllDay) ? fields.startDate : apiDate(start, fields.isAllDay),
    dueDate: due === dateInput(fields.dueDate, fields.isAllDay) ? fields.dueDate : apiDate(due, fields.isAllDay, true),
  };
}
