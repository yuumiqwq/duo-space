// Loaded only by the isolated test server. No requests reach real Dida accounts.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const original = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url || input.href);
  if (url.hostname !== 'api.dida365.com') return original(input, init);
  const owner = new Headers(init.headers).get('authorization')?.replace('Bearer fixture-', '');
  if (!['alice', 'bob'].includes(owner)) return new Response(null, { status: 401 });
  const file = path.join(process.env.DATA_DIR, 'fake-dida.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8')), tasks = state[owner];
  const route = url.pathname.replace('/open/v1', ''), method = init.method || 'GET';
  const save = () => fs.writeFileSync(file, JSON.stringify(state));
  if (route === '/project') return Response.json([]);
  if (route === '/task/filter') {
    const body = JSON.parse(init.body || '{}');
    return Response.json(Object.values(tasks).filter(task => !body.status || body.status.includes(task.status || 0)));
  }
  if (route === '/task/completed') {
    const body = JSON.parse(init.body || '{}');
    return Response.json(Object.values(tasks).filter(task => task.status === 2 && (!body.startDate || Date.parse(task.completedTime) >= Date.parse(body.startDate))).slice(0, 200));
  }
  if (route === '/project/inbox') return Response.json({ id: `inbox-${owner}` });
  if (route === '/project/inbox/data') {
    if (owner === 'bob' && process.env.DIDA_FIXTURE_INBOX_DELAY_MS) await new Promise(resolve => setTimeout(resolve, Number(process.env.DIDA_FIXTURE_INBOX_DELAY_MS)));
    return Response.json({ tasks: Object.values(tasks).filter(task => !task.status), columns: [] });
  }
  if (route === '/task/batch') {
    const body = JSON.parse(init.body), ids = {};
    for (const task of body.add || []) { const id = randomUUID().replaceAll('-', '').slice(0, 24); tasks[id] = { ...task, id }; ids[id] = 'created'; }
    for (const task of body.update || []) { tasks[task.id] = { ...task, etag: 'reopened' }; ids[task.id] = 'reopened'; }
    save(); return Response.json({ id2etag: ids });
  }
  if (route.endsWith('/comments')) return Response.json([]);
  if (route.startsWith('/task/') && method === 'POST') {
    const id = route.slice('/task/'.length);
    if (!tasks[id]) return new Response(null, { status: 404 });
    tasks[id] = { ...tasks[id], ...JSON.parse(init.body) }; save(); return Response.json(tasks[id]);
  }
  const match = route.match(/^\/project\/([^/]+)\/task\/([^/]+)(\/complete)?$/);
  if (match && match[1] === `inbox-${owner}`) {
    const id = match[2];
    if (!tasks[id]) return new Response(null, { status: 404 });
    if (method === 'DELETE') {
      if (tasks[id].fixtureDeleteFailure) { tasks[id].deleteAttempts = (tasks[id].deleteAttempts || 0) + 1; save(); return new Response(null, { status: 503 }); }
      delete tasks[id]; save(); return new Response(null, { status: 204 });
    }
    if (match[3] && method === 'POST') { tasks[id].status = 2; tasks[id].completedTime = new Date().toISOString(); save(); return new Response(null, { status: 204 }); }
    return Response.json(tasks[id]);
  }
  return new Response(null, { status: 404 });
};
