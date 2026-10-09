import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

// Stores keep their own schemas and transaction boundaries. This helper only
// publishes a complete file; it never removes the previous version on failure.
export async function writeStoreFile(filename: string, contents: string): Promise<void> {
  await mkdir(/* turbopackIgnore: true */ path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(/* turbopackIgnore: true */ temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(/* turbopackIgnore: true */ temporary, filename); break; }
      catch (error) {
        // Windows readers and scanners can briefly hold the destination.
        const code = (error as NodeJS.ErrnoException).code || '';
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code) || attempt >= 5) throw error;
        await delay(25 * 2 ** attempt);
      }
    }
  } finally {
    await unlink(/* turbopackIgnore: true */ temporary).catch(() => undefined);
  }
}
