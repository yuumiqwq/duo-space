import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { attachmentPath, descriptionAttachments } from "../../../../task-description-attachments.ts";
import { withCloudCapacity, cloudRoot, resolveCloudPath, sanitizeFileName } from "../../../cloud/store.ts";
import { readAttachmentReferences, withAttachmentLock } from '../attachment-coordination.ts';

const maxSize = 20 * 1024 * 1024, maxDraftBytes = 200 * 1024 * 1024, expiry = 24 * 3600000;
const shared = globalThis as typeof globalThis & { taskAttachmentStageQueues?: Map<string, Promise<unknown>> };
const staging = shared.taskAttachmentStageQueues ||= new Map<string, Promise<unknown>>();
type Draft = { actor: string; path: string; name: string; size: number; createdAt: number };
export class TaskAttachmentError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export const attachmentPaths = (content: string) => [...new Set(descriptionAttachments(content).attachments.map(file => file.path))];

export class TaskAttachmentStore {
  private directory: string;
  private dataDirectory: string;
  constructor(dataDirectory: string) { this.dataDirectory = dataDirectory; this.directory = path.join(/* turbopackIgnore: true */ dataDirectory, 'task-attachment-drafts'); }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const directory = path.resolve(this.dataDirectory), key = process.platform === 'win32' ? directory.toLowerCase() : directory;
    const result = (staging.get(key) || Promise.resolve()).then(work), pending = result.catch(() => undefined);
    staging.set(key, pending);
    void pending.then(() => { if (staging.get(key) === pending) staging.delete(key); });
    return result;
  }
  private async draft(relative: string) {
    const id = relative.split('/')[2];
    if (!/^[a-f0-9-]{36}$/i.test(id || '')) return null;
    try {
      const draft: Draft = JSON.parse(await readFile(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ this.directory, `${id}.json`), 'utf8'));
      return draft.path === relative ? { ...draft, binary: path.join(/* turbopackIgnore: true */ this.directory, `${id}.bin`) } : null;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async cloudFile(relative: string) {
    const target = resolveCloudPath(relative);
    if (!attachmentPath(relative) || target.normalized !== relative) throw new TaskAttachmentError('附件路径无效');
    let cursor = cloudRoot;
    for (const part of ['', ...relative.split('/')]) {
      if (part) cursor = path.join(cursor, part);
      try { if ((await lstat(/* turbopackIgnore: true */ cursor)).isSymbolicLink()) throw new TaskAttachmentError('附件路径无效'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
    }
    return target.resolved;
  }
  stage(actor: string, task: string, name: string, body: ReadableStream<Uint8Array>) {
    return this.serial(async () => {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(task)) throw new TaskAttachmentError('任务编号无效');
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const used = await withAttachmentLock(this.dataDirectory, async () => {
        const references = await readAttachmentReferences(this.dataDirectory);
        const entries = await readdir(/* turbopackIgnore: true */ this.directory), knownEntries = new Set(entries);
        let total = 0;
        for (const entry of entries) {
          if (!/^[a-f0-9-]{36}\.json$/i.test(entry)) continue;
          const location = path.join(/* turbopackIgnore: true */ this.directory, entry), item: Draft = JSON.parse(await readFile(/* turbopackIgnore: true */ location, 'utf8'));
          if (Date.now() - item.createdAt > expiry && !references.descriptions.has(item.path)) {
            await unlink(location.replace(/\.json$/, '.bin')).catch(error => { if (error.code !== 'ENOENT') throw error; });
            await unlink(location);
          } else if (item.actor === actor) total += item.size;
        }
        // Metadata-less remnants retain the old age-based cleanup, but never
        // consume a referenced ID or a live stream from another store instance.
        const referencedIds = new Set([...references.descriptions].map(relative => relative.split('/')[2]));
        for (const entry of entries) if (/^[a-f0-9-]{36}\.bin$/i.test(entry) && !knownEntries.has(entry.replace(/\.bin$/, '.json')) && !referencedIds.has(entry.slice(0, -4))) {
          const location = path.join(/* turbopackIgnore: true */ this.directory, entry);
          if (Date.now() - (await stat(/* turbopackIgnore: true */ location)).mtimeMs > expiry) await unlink(location);
        }
        return total;
      });
      const id = randomUUID(), filename = sanitizeFileName(name), relative = `tasks/${task}/${id}/${filename}`;
      const binary = path.join(/* turbopackIgnore: true */ this.directory, `${id}.bin`), metadata = path.join(/* turbopackIgnore: true */ this.directory, `${id}.json`);
      const handle = await open(/* turbopackIgnore: true */ binary, 'wx', 0o600), reader = body.getReader();
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > maxSize) throw new TaskAttachmentError('单个附件不能超过20 MB', 413);
          if (used + size > maxDraftBytes) throw new TaskAttachmentError('未保存附件过多，请先保存已有修改', 413);
          await handle.write(value);
        }
        await handle.close();
        await writeFile(metadata, JSON.stringify({ actor, path: relative, name: filename, size, createdAt: Date.now() } satisfies Draft), { flag: 'wx', mode: 0o600 });
        return { name: filename, path: relative, size, kind: 'file' };
      } catch (error) {
        await reader.cancel().catch(() => undefined); await handle.close().catch(() => undefined);
        await unlink(binary).catch(() => undefined); await unlink(metadata).catch(() => undefined); throw error;
      } finally { reader.releaseLock(); }
    });
  }
  async readable(actor: string, relative: string) {
    const destination = await this.cloudFile(relative);
    try { if ((await stat(/* turbopackIgnore: true */ destination)).isFile()) return destination; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const draft = await this.draft(relative);
    if (!draft || draft.actor !== actor || Date.now() - draft.createdAt > expiry) throw new TaskAttachmentError('附件不存在或尚未保存', 404);
    return draft.binary;
  }
  publish(actor: string, before: string, after: string) {
    return withAttachmentLock(this.dataDirectory, async () => {
      const old = new Set(attachmentPaths(before));
      for (const relative of attachmentPaths(after).filter(item => !old.has(item))) {
        const destination = await this.cloudFile(relative);
        try { if ((await stat(/* turbopackIgnore: true */ destination)).isFile()) continue; throw new TaskAttachmentError('附件路径不是文件'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const draft = await this.draft(relative);
        if (!draft || draft.actor !== actor || Date.now() - draft.createdAt > expiry) throw new TaskAttachmentError('附件暂存已失效，请重新添加附件');
        await withCloudCapacity(draft.size, async () => {
          await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          // A failed copy is removed; task writes only begin after every file is ready.
          try { await copyFile(/* turbopackIgnore: true */ draft.binary, destination, constants.COPYFILE_EXCL); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { await unlink(destination).catch(() => undefined); throw error; } }
        });
        // Saved files no longer occupy the uploader's temporary allowance.
        await unlink(draft.binary);
        await unlink(draft.binary.replace(/\.bin$/, '.json'));
      }
    });
  }
  remove(files: string[]) {
    return withAttachmentLock(this.dataDirectory, async () => {
      for (const relative of files) {
        const destination = await this.cloudFile(relative);
        try {
          if (!(await lstat(/* turbopackIgnore: true */ destination)).isFile()) throw new TaskAttachmentError('附件路径不是文件');
          await unlink(destination);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const draft = await this.draft(relative);
        if (draft) {
          await unlink(draft.binary).catch(error => { if (error.code !== 'ENOENT') throw error; });
          await unlink(draft.binary.replace(/\.bin$/, '.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
      }
    });
  }
}
