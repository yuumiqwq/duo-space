import { taskSyncRuntime } from '../../room/tasks/scheduler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET() {
  const { instanceId, active, lastRunAt, running } = taskSyncRuntime;
  return Response.json({ instanceId, active, lastRunAt, running }, { headers: { 'Cache-Control': 'no-store, max-age=0', 'X-Robots-Tag': 'noindex, nofollow' } });
}
