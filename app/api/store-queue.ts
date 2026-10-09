import path from 'node:path';

// Route bundles can load separate copies of a store in the same server process.
// Coordinate by the actual file, while each store owns its validation and write.
const shared = globalThis as typeof globalThis & { fileStoreQueues?: Map<string, { pending: Promise<unknown> }> };
const queues = shared.fileStoreQueues ||= new Map();
export function fileStoreQueue(filename: string) {
  const resolved = path.resolve(filename);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const queue = queues.get(key) || { pending: Promise.resolve() };
  queues.set(key, queue);
  return {
    settled: () => queue.pending,
    run<T>(work: () => Promise<T>): Promise<T> {
      const result = queue.pending.then(work);
      queue.pending = result.catch(() => undefined);
      return result;
    },
  };
}
