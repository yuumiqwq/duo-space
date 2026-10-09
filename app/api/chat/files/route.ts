import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { currentIdentityId } from "../../identity/session";
import { autoImportChatFile } from "../../cloud/store";

export const runtime = "nodejs";

const dataDirectory = process.env.DATA_DIR
  || (process.env.NODE_ENV === "production" ? "/data" : path.join(process.cwd(), ".data"));
const fileDirectory = path.join(dataDirectory, "chat-files");

export async function POST(request: NextRequest) {
  if (!(await currentIdentityId())) return new NextResponse("Unauthorized", { status: 401 });
  if (!request.body) return NextResponse.json({ error: "请选择文件" }, { status: 400 });
  let name = "file";
  try { name = decodeURIComponent(request.headers.get("x-file-name") || "file"); } catch { /* keep fallback */ }
  name = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255) || "file";
  const mimeType = (request.headers.get("content-type") || "application/octet-stream").slice(0, 255);
  const id = crypto.randomUUID();
  const temporaryPath = path.join(fileDirectory, `${id}.${process.pid}.tmp`);
  const finalPath = path.join(fileDirectory, `${id}.bin`);
  const metadataPath = path.join(fileDirectory, `${id}.json`);
  const temporaryMetadataPath = `${metadataPath}.${process.pid}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let published = false;
  let size = 0;
  const kind = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "audio" : "file";
  try {
    await mkdir(fileDirectory, { recursive: true, mode: 0o700 });
    handle = await open(temporaryPath, "wx", 0o600);
    reader = request.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) {
        await handle.writeFile(value);
        size += value.byteLength;
      }
    }
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, finalPath);
    await writeFile(temporaryMetadataPath, JSON.stringify({ id, name, size, mimeType, kind }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryMetadataPath, metadataPath);
    published = true;
  } catch {
    await reader?.cancel().catch(() => undefined);
    return NextResponse.json({ error: "上传中断，请重试" }, { status: 400 });
  } finally {
    reader?.releaseLock();
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    await rm(temporaryMetadataPath, { force: true }).catch(() => undefined);
    if (!published) {
      await rm(finalPath, { force: true }).catch(() => undefined);
      await rm(metadataPath, { force: true }).catch(() => undefined);
    }
  }
  const cloud = kind === "file" ? await autoImportChatFile(id, finalPath, name, size) : null;
  return NextResponse.json({
    attachment: { id, url: `/api/chat/files/${id}`, name, size, mimeType, kind },
    cloudWarning: cloud?.warning || undefined,
  }, { status: 201 });
}
