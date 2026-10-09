import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileStoreQueue } from '../../store-queue.ts';
import { writeStoreFile } from '../../store-file.ts';

export class BoardDeletionStore {
  private queue: ReturnType<typeof fileStoreQueue>;
  private file: string;
  constructor(directory: string) {
    this.file = path.join(directory, 'deleted-boards.json');
    this.queue = fileStoreQueue(this.file);
  }
  async read(): Promise<string[]> {
    await this.queue.settled();
    return this.readFile();
  }
  private async readFile(): Promise<string[]> {
    try { return JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  delete(id: string): Promise<string[]> {
    return this.queue.run(async () => {
      const ids = await this.readFile();
      if (ids.includes(id)) return ids;
      ids.push(id);
      await writeStoreFile(this.file, JSON.stringify(ids));
      return ids;
    });
  }
}

export const boardDeletionStore = new BoardDeletionStore(process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/data' : path.join(process.cwd(), '.data')));
