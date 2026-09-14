import { NextResponse } from "next/server";
import { accessToken } from "../store";
import { tickFetch } from "../client";
import { currentIdentityId } from "../../identity/session";
import { store } from "../../room/tasks/service";
import { CollaborationError } from "../../room/tasks/store";
import { todoStore } from '../../room/todo/store';

export async function POST(request: Request) {
  const identityId = await currentIdentityId();
  if (!identityId) return new NextResponse("Unauthorized", { status: 401 });
  const origin = request.headers.get("origin");
  if (origin) { try { if (new URL(origin).host !== request.headers.get("host")) return new NextResponse("Invalid origin", { status: 403 }); } catch { return new NextResponse("Invalid origin", { status: 403 }); } }
  const body = await request.json().catch(() => ({}));
  if ([body.identityId, body.targetIdentityId, body.ownerId].some((id) => id !== undefined && id !== identityId)) {
    return new NextResponse("Cannot modify another member's task", { status: 403 });
  }
  const token = await accessToken();
  if (!token) return new NextResponse("Not connected", { status: 401 });
  if (typeof body.projectId !== "string" || typeof body.taskId !== "string") return new NextResponse("Invalid task", { status: 400 });
  try { const result = await store.personalCompletion(identityId, body.taskId, async () => {
  const response = await tickFetch(`/project/${encodeURIComponent(body.projectId)}/task/${encodeURIComponent(body.taskId)}/complete`, token, {
    method: "POST",
  });
  return new NextResponse(null, { status: response.ok ? 204 : response.status });
  });
  if (result instanceof Response ? result.ok : result.status === 'done') await todoStore.complete(identityId, body.taskId);
  return result instanceof Response ? result : NextResponse.json({ workflow: result }); } catch (error) { return NextResponse.json({ error: error instanceof CollaborationError ? error.message : "完成状态没有同步成功" }, { status: error instanceof CollaborationError ? error.status : 503 }); }
}
