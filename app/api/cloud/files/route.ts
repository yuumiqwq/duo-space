import { NextRequest, NextResponse } from "next/server";
import { currentIdentityId } from "../../identity/session";
import { CloudCapacityError, saveCloudUpload, deleteCloudItem } from "../store";

export const runtime = "nodejs";

export async function DELETE(request: NextRequest) {
  if (!(await currentIdentityId())) return new NextResponse("Unauthorized", { status: 401 });
  const origin = request.headers.get("origin");
  if (origin) {
    try { if (new URL(origin).host !== request.headers.get("host")) return new NextResponse("Forbidden", { status: 403 }); }
    catch { return new NextResponse("Forbidden", { status: 403 }); }
  }
  const body = await request.json().catch(() => ({}));
  if (typeof body.path !== "string" || body.confirmed !== true) return NextResponse.json({ error: "请确认要删除的文件或文件夹" }, { status: 400 });
  try {
    await deleteCloudItem(body.path);
    return NextResponse.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message === "INVALID_PATH" ? "不能删除此路径" : "删除失败，请重试" }, { status: (error as Error).message === "INVALID_PATH" ? 400 : 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!(await currentIdentityId())) return new NextResponse("Unauthorized", { status: 401 });
  const origin = request.headers.get("origin");
  if (origin) {
    try { if (new URL(origin).host !== request.headers.get("host")) return new NextResponse("Forbidden", { status: 403 }); }
    catch { return new NextResponse("Forbidden", { status: 403 }); }
  }
  if (!request.body) return NextResponse.json({ error: "请选择文件" }, { status: 400 });
  let name = "file";
  try { name = decodeURIComponent(request.headers.get("x-file-name") || "file"); } catch { /* keep fallback */ }
  const contentLength = Number(request.headers.get("content-length") || 0);
  try {
    const item = await saveCloudUpload(request.body, request.nextUrl.searchParams.get("path") || "", name,
      Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : 0);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    const tooLarge = (error as Error).message === "TASK_ATTACHMENT_TOO_LARGE";
    return NextResponse.json({ error: tooLarge ? "单个附件不能超过20 MB" : error instanceof CloudCapacityError ? error.message : "上传失败，请重试" }, { status: tooLarge ? 413 : error instanceof CloudCapacityError ? 507 : 500 });
  }
}
