import { NextResponse } from "next/server";
import { accessToken } from "../store";
import { classroomDay, todayTasks } from "../../../classroom-view";
import { classroomTodoTasks, classroomTodoWindow } from '../../../classroom-todo';
import { currentIdentityId } from '../../identity/session';
import { todoStore } from '../../room/todo/store';

import { tickFetch, tickInboxData, TickApiError, filterTasksByView, type TickProject, type TickTask, type TaskView } from "../client";

export async function GET(request: Request) {
  const token = await accessToken();
  if (!token) return new NextResponse("Not connected", { status: 401 });
  const requestedView = new URL(request.url).searchParams.get("view");
  const view: TaskView = requestedView === "today" ? "today" : requestedView === "undated" ? "undated" : "week";
  const classroom = view === 'today' && new URL(request.url).searchParams.get('classroom') === '1';
  const historyRequest = classroom ? tickFetch('/task/completed', token, { method: 'POST', body: JSON.stringify({}) }).then(async response => {
    const history = response.ok ? await response.json() : null;
    return Array.isArray(history) ? history : null;
  }).catch(() => null) : Promise.resolve(null);
  const [projectResult, inboxResult] = await Promise.allSettled([
    tickFetch('/project', token).then(async response => { if (!response.ok) throw new TickApiError('TickTick unavailable', response.status); const projects = await response.json(); if (!Array.isArray(projects) || projects.some(project => !project || typeof project.id !== 'string' || typeof project.name !== 'string')) throw new Error('TickTick unavailable'); return projects as TickProject[]; }),
    tickInboxData(token),
  ]);
  const authorizationFailure = (result: PromiseSettledResult<unknown>) => result.status === 'rejected' && result.reason instanceof TickApiError && [401, 403].includes(result.reason.status);
  if (authorizationFailure(projectResult) && authorizationFailure(inboxResult)) return new NextResponse('Not connected', { status: 401 });
  const projects = projectResult.status === 'fulfilled' ? projectResult.value : [];
  const activeProjects = projects.filter(project => !project.closed);
  const inbox = inboxResult.status === 'fulfilled' ? inboxResult.value : null;
  let inboxError = inboxResult.status === 'rejected' ? inboxResult.reason instanceof Error ? inboxResult.reason.message : '收集箱暂时无法读取' : '';
  const inboxId = inbox?.projectId || '';
  const projectsToRead = inboxId && !activeProjects.some(project => project.id === inboxId)
    ? [...activeProjects, { id: inboxId, name: '收集箱' }] : activeProjects;
  const datasetResponses = await Promise.all(projectsToRead.map(async project => {
    if (inbox && project.id === inbox.projectId) return { ok: true, projectId: inbox.projectId, tasks: inbox.tasks };
    try {
      const response = await tickFetch('/project/' + encodeURIComponent(project.id) + '/data', token);
      const data = response.ok ? await response.json() : null;
      if (!Array.isArray(data?.tasks)) throw new Error('TickTick task read failed');
      return { ok: true, projectId: project.id, tasks: data.tasks as TickTask[] };
    } catch { return { ok: false, projectId: project.id, tasks: [] as TickTask[] }; }
  }));
  const failedProjectIds = datasetResponses.filter(dataset => !dataset.ok).map(dataset => dataset.projectId);
  const incompleteProjects = projectResult.status === 'rejected';
  if (failedProjectIds.length || incompleteProjects) inboxError ||= '暂时无法读取滴答清单';
  if (inboxResult.status === 'rejected') failedProjectIds.push(...(projectsToRead.filter(project => project.id === 'inbox').map(project => project.id)));

  const projectNames = new Map(projectsToRead.map((project) => [project.id, project.name]));
  const uniqueTasks = new Map<string, TickTask>();
  for (const task of datasetResponses.flatMap((dataset) => dataset.tasks)) {
    if (task && typeof task.id === "string") uniqueTasks.set(task.id, task);
  }
  const exactToday = view === "today" && new URL(request.url).searchParams.get("exact") === "1";
  const now = Date.now();
  let historyWarning = '';
  if (classroom) {
    try {
      const history = await historyRequest;
      if (!Array.isArray(history)) throw new Error('history unavailable');
      for (const item of history) {
        if (!item || typeof item.id !== 'string' || typeof item.title !== 'string' || item.status !== 2) continue;
        if (!uniqueTasks.has(item.id)) uniqueTasks.set(item.id, item);
      }
    } catch { historyWarning = '滴答历史暂时无法读取，已保留本站当天勾选的任务'; }
  }
  const sourceTasks = [...uniqueTasks.values()];
  const normalizeTodo = (task: TickTask & { completedTime?: string }) => ({ ...task, dueDate: task.dueDate || task.startDate, done: !!task.status,
    completedDay: task.completedTime && Number.isFinite(Date.parse(task.completedTime)) ? classroomTodoWindow(Date.parse(task.completedTime)).day : undefined });
  const filtered = classroom
    ? classroomTodoTasks(sourceTasks.map(normalizeTodo), now)
    : exactToday
    ? todayTasks(sourceTasks.map(task => ({ ...task, dueDate: task.dueDate || task.startDate, done: !!task.status })), classroomDay()).sort((a, b) => Date.parse(a.dueDate || "") - Date.parse(b.dueDate || ""))
    : filterTasksByView(sourceTasks, view);
  let tasks = filtered
    .map((task) => ({
      id: task.id,
      projectId: task.projectId,
      title: task.title,
      project: projectNames.get(task.projectId) || "滴答清单",
      dueDate: task.dueDate || task.startDate,
      startDate: task.startDate,
      isAllDay: task.isAllDay,
      done: classroom ? !!task.status : false,
      ...(classroom ? { completedDay: normalizeTodo(task).completedDay } : {}),
    }));
  if (classroom) {
    const identity = await currentIdentityId();
    if (!identity) return new NextResponse('Unauthorized', { status: 401 });
    tasks = await todoStore.reconcile(identity, tasks, now, { failedProjectIds, incompleteProjects, inboxFailed: inboxResult.status === 'rejected', readProjectIds: datasetResponses.filter(dataset => dataset.ok).map(dataset => dataset.projectId) }) as typeof tasks;
  }
  return NextResponse.json({
    view,
    ...(inboxError || historyWarning ? { inboxError: [inboxError, historyWarning].filter(Boolean).join('；') } : {}),
    failedProjectIds, incompleteProjects,
    projects: projectsToRead.map(({ id, name }) => ({ id, name })),
    tasks,
  });
}

export async function POST(request: Request) {
  const token = await accessToken();
  if (!token) return new NextResponse("Not connected", { status: 401 });
  const body = await request.json().catch(() => ({}));
  if (typeof body.title !== "string" || typeof body.projectId !== "string") return new NextResponse("Invalid task", { status: 400 });
  const requestedDate = typeof body.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate)
    ? body.dueDate
    : "";
  const dueDate = requestedDate ? `${requestedDate}T23:59:00+0800` : undefined;
  const response = await tickFetch("/task", token, {
    method: "POST",
    body: JSON.stringify({
      title: body.title.trim(),
      projectId: body.projectId,
      ...(dueDate ? { dueDate } : {}),
      isAllDay: true,
      timeZone: "Asia/Shanghai",
    }),
  });
  return new NextResponse(await response.text(), { status: response.status, headers: { "Content-Type": "application/json" } });
}
