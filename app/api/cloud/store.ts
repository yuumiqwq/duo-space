import { constants } from "node:fs";
import { copyFile, link, mkdir, open, readFile, readdir, stat, lstat, rm } from "node:fs/promises";
import path from "node:path";

import { cloudRoot, cloudStagingRoot, sanitizeFileName, resolveCloudPath, ensureCloudFolders } from "./paths.ts";
import { CloudCapacityError, cloudStatus, reserveCloudCapacity, coordinateCloudWrite, checkCloudCapacity } from "./capacity.ts";

export { cloudRoot, cloudStagingRoot, sanitizeFileName, normalizeCloudPath, resolveCloudPath, ensureCloudFolders } from "./paths.ts";
export { cloudLimitBytes, cloudWarningBytes, CloudCapacityError, cloudStatus, assertCloudCapacity, reserveCloudCapacity, withCloudCapacity } from "./capacity.ts";

const importedPrefix = /^__chat_[0-9a-f-]{36}__(.+)$/i;

export async function listCloudFolder(relativePath: string) {
  await ensureCloudFolders();
  const { normalized, resolved } = resolveCloudPath(relativePath);
  const entries = await readdir(/* turbopackIgnore: true */ resolved, { withFileTypes: true });
  const items = await Promise.all(entries.filter((entry) => entry.isFile() || entry.isDirectory()).map(async (entry) => {
    const itemPath = normalized ? `${normalized}/${entry.name}` : entry.name;
    const details = await stat(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ resolved, entry.name));
    const imported = entry.name.match(importedPrefix);
    return {
      name: imported?.[1] || entry.name,
      path: itemPath,
      kind: entry.isDirectory() ? "folder" as const : "file" as const,
      size: entry.isFile() ? details.size : 0,
      updatedAt: details.mtimeMs,
    };
  }));
  items.sort((left, right) => Number(left.kind === "file") - Number(right.kind === "file") || left.name.localeCompare(right.name, "zh-CN"));
  return { path: normalized, items, status: await cloudStatus() };
}

export async function createCloudFolder(parentPath: string, name: string) {
  await ensureCloudFolders();
  const parent = resolveCloudPath(parentPath);
  const folderName = sanitizeFileName(name, "新建文件夹");
  const destination = path.join(/* turbopackIgnore: true */ parent.resolved, folderName);
  await mkdir(destination, { mode: 0o700 });
  return parent.normalized ? `${parent.normalized}/${folderName}` : folderName;
}

async function linkWithoutReplacement(source: string, destination: string) {
  try { await link(/* turbopackIgnore: true */ source, destination); }
  catch (error) {
    if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
    await copyFile(/* turbopackIgnore: true */ source, destination, constants.COPYFILE_EXCL);
  }
}

async function publishWithAvailableName(source: string, directory: string, fileName: string) {
  const extension = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length);
  for (let suffix = 0; suffix < 10000; suffix += 1) {
    const candidate = suffix ? `${stem} (${suffix})${extension}` : fileName;
    try {
      const destination = path.join(/* turbopackIgnore: true */ directory, candidate);
      await linkWithoutReplacement(source, destination);
      return destination;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  const destination = path.join(/* turbopackIgnore: true */ directory, `${crypto.randomUUID()}-${fileName}`);
  await linkWithoutReplacement(source, destination);
  return destination;
}

export async function saveCloudUpload(body: ReadableStream<Uint8Array>, relativePath: string, name: string, expectedBytes = 0) {
  const parent = resolveCloudPath(relativePath);
  const taskAttachment = parent.normalized === "tasks" || parent.normalized.startsWith("tasks/");
  const maximum = taskAttachment ? 20 * 1024 * 1024 : Infinity;
  if (expectedBytes > maximum) throw new Error("TASK_ATTACHMENT_TOO_LARGE");
  const reservation = await reserveCloudCapacity(expectedBytes);
  const temporaryPath = path.join(/* turbopackIgnore: true */ cloudStagingRoot, `${crypto.randomUUID()}.upload`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let size = 0, reserved = expectedBytes;
  try {
    await mkdir(parent.resolved, { recursive: true, mode: 0o700 });
    await mkdir(/* turbopackIgnore: true */ cloudStagingRoot, { recursive: true, mode: 0o700 });
    handle = await open(/* turbopackIgnore: true */ temporaryPath, "wx", 0o600);
    reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      size += value.byteLength;
      if (size > maximum) throw new Error("TASK_ATTACHMENT_TOO_LARGE");
      if (size > reserved) { await reservation.resize(size); reserved = size; }
      await handle.writeFile(value);
    }
    await handle.close();
    handle = undefined;
    const destination = await reservation.commit(size, () => publishWithAvailableName(temporaryPath, parent.resolved, sanitizeFileName(name)));
    const fileName = path.basename(destination);
    return { name: fileName, path: parent.normalized ? `${parent.normalized}/${fileName}` : fileName, kind: "file" as const, size };
  } catch (error) {
    await reader?.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader?.releaseLock();
    await handle?.close().catch(() => undefined);
    await rm(/* turbopackIgnore: true */ temporaryPath, { force: true }).catch(() => undefined);
    await reservation.release();
  }
}

export async function importChatAttachment(id: string, sourcePath: string, name: string, size: number, target: "chat" | "chat/pics" | "video") {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid attachment size");
  await ensureCloudFolders();
  const destinationDirectory = path.join(cloudRoot, ...target.split("/"));
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  const storedName = `__chat_${id}__${sanitizeFileName(name)}`;
  const destination = path.join(/* turbopackIgnore: true */ destinationDirectory, storedName);
  // Check idempotency inside the same queue as capacity and publication. Use
  // the actual source size rather than trusting older attachment metadata.
  await coordinateCloudWrite(async () => {
    try {
      const existing = await lstat(/* turbopackIgnore: true */ destination);
      if (!existing.isFile()) throw new Error("Invalid attachment destination");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const source = await stat(/* turbopackIgnore: true */ sourcePath);
    if (!source.isFile()) throw new Error("Invalid attachment source");
    await checkCloudCapacity(source.size);
    await linkWithoutReplacement(sourcePath, destination);
  });
  return `${target}/${storedName}`;
}

export async function autoImportChatFile(id: string, sourcePath: string, name: string, size: number) {
  try {
    return { path: await importChatAttachment(id, sourcePath, name, size, "chat"), warning: "" };
  } catch (error) {
    if (error instanceof CloudCapacityError) return { path: "", warning: error.message };
    return { path: "", warning: "文件已发送，但自动保存到云盘失败" };
  }
}

export async function readChatAttachmentMetadata(id: string) {
  const dataRoot = process.env.DATA_DIR || (process.env.NODE_ENV === "production" ? "/data" : path.join(process.cwd(), ".data"));
  const directory = path.join(/* turbopackIgnore: true */ dataRoot, "chat-files");
  const metadata = JSON.parse(await readFile(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ directory, `${id}.json`), "utf8")) as {
    name?: unknown; size?: unknown; mimeType?: unknown; kind?: unknown;
  };
  if ((metadata.kind !== "image" && metadata.kind !== "audio") || typeof metadata.name !== "string" || typeof metadata.size !== "number") {
    throw new Error("仅支持手动保存聊天图片或语音");
  }
  return { sourcePath: path.join(/* turbopackIgnore: true */ directory, `${id}.bin`), name: metadata.name, size: metadata.size, kind: metadata.kind };
}

export async function deleteCloudItem(relativePath: string) {
  if (!relativePath || relativePath.length > 800 || relativePath.includes("\\") || relativePath.startsWith("/")
    || relativePath.split("/").some(part => !part || part === "." || part === ".." || /[:\u0000-\u001f]/.test(part))) throw new Error("INVALID_PATH");
  const { normalized, resolved } = resolveCloudPath(relativePath);
  if (normalized !== relativePath || resolved === path.resolve(cloudRoot)) throw new Error("INVALID_PATH");
  // Never follow a symlink outside the drive, including symlinked parent folders.
  let cursor = cloudRoot;
  for (const part of ["", ...relativePath.split("/")]) {
    if (part) cursor = path.join(cursor, part);
    try { if ((await lstat(/* turbopackIgnore: true */ cursor)).isSymbolicLink()) throw new Error("INVALID_PATH"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
  await rm(resolved, { recursive: true, force: true });
}
