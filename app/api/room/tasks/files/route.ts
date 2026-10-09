import { NextRequest, NextResponse } from "next/server";
import { currentIdentityId } from "../../../identity/session";
import { store, collaborationDirectory } from "../service";
import { CollaborationError } from "../domain.ts";
import { uploadFile } from "./storage";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  const actor = await currentIdentityId();
  if (!actor) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const origin = request.headers.get("origin");
  if (origin) { try { if (new URL(origin).host !== request.headers.get("host")) return NextResponse.json({ error: "无效来源" }, { status: 403 }); } catch { return NextResponse.json({ error: "无效来源" }, { status: 403 }); } }
  try {
    const workflowId = request.nextUrl.searchParams.get("workflow") || "", name = request.nextUrl.searchParams.get("name") || "";
    const file = await uploadFile(collaborationDirectory, request, workflowId, actor, name, () => store.attachmentAccess(actor, workflowId, true));
    return NextResponse.json({ file }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return NextResponse.json({ error: error instanceof CollaborationError ? error.message : "附件上传未完成，请重试" }, { status: error instanceof CollaborationError ? error.status : 503 }); }
}
