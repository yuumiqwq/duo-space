import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { cloudRoot, ensureCloudFolders } from "./paths.ts";

const defaultLimitBytes = 5 * 1024 * 1024 * 1024;
const configuredLimit = Number(process.env.CLOUD_DRIVE_LIMIT_BYTES);
export const cloudLimitBytes = Number.isSafeInteger(configuredLimit) && configuredLimit > 0
  ? configuredLimit
  : defaultLimitBytes;
export const cloudWarningBytes = Math.floor(cloudLimitBytes * 0.9);

// Next may load this module through multiple route bundles. Share the queue and
// reservations across those copies, scoped to the configured data directory.
type CapacityState = { queue: Promise<unknown>; reservations: Map<symbol, number> };
const shared = globalThis as typeof globalThis & { __cloudCapacityStates?: Map<string, CapacityState> };
const states = shared.__cloudCapacityStates ??= new Map();
const capacity = states.get(path.resolve(cloudRoot)) ?? { queue: Promise.resolve(), reservations: new Map<symbol, number>() };
states.set(path.resolve(cloudRoot), capacity);

export function coordinateCloudWrite<T>(work: () => Promise<T>): Promise<T> {
  const operation = capacity.queue.then(work);
  capacity.queue = operation.catch(() => undefined);
  return operation;
}

export class CloudCapacityError extends Error {
  status = 507;
  constructor(message = "云盘容量已达到 90%，请清理空间后再上传") {
    super(message);
  }
}

async function directoryUsage(directory: string): Promise<number> {
  let total = 0;
  let entries;
  try { entries = await readdir(/* turbopackIgnore: true */ directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  for (const entry of entries) {
    const entryPath = path.join(/* turbopackIgnore: true */ directory, entry.name);
    if (entry.isDirectory()) total += await directoryUsage(entryPath);
    else if (entry.isFile()) {
      try { total += (await stat(/* turbopackIgnore: true */ entryPath)).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  return total;
}

export async function cloudStatus() {
  await ensureCloudFolders();
  const usedBytes = await directoryUsage(cloudRoot);
  return {
    usedBytes,
    limitBytes: cloudLimitBytes,
    warningBytes: cloudWarningBytes,
    warning: usedBytes >= cloudWarningBytes,
    percent: Math.min(100, Math.round((usedBytes / cloudLimitBytes) * 1000) / 10),
  };
}

export async function checkCloudCapacity(additionalBytes: number, ownReservation?: symbol) {
  const status = await cloudStatus();
  let reservedBytes = 0;
  for (const [id, bytes] of capacity.reservations) if (id !== ownReservation) reservedBytes += bytes;
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0 || status.warning
    || status.usedBytes + reservedBytes + additionalBytes > cloudWarningBytes) {
    throw new CloudCapacityError();
  }
  return status;
}

export function assertCloudCapacity(additionalBytes: number) {
  return coordinateCloudWrite(() => checkCloudCapacity(additionalBytes));
}

export async function reserveCloudCapacity(initialBytes: number) {
  const id = Symbol("cloud-write");
  await coordinateCloudWrite(async () => {
    await checkCloudCapacity(initialBytes);
    capacity.reservations.set(id, initialBytes);
  });
  return {
    resize(bytes: number) {
      return coordinateCloudWrite(async () => {
        if (!capacity.reservations.has(id)) throw new Error("Cloud reservation is closed");
        await checkCloudCapacity(bytes, id);
        capacity.reservations.set(id, bytes);
      });
    },
    commit<T>(bytes: number, publish: () => Promise<T>): Promise<T> {
      return coordinateCloudWrite(async () => {
        if (!capacity.reservations.has(id)) throw new Error("Cloud reservation is closed");
        await checkCloudCapacity(bytes, id);
        const result = await publish();
        capacity.reservations.delete(id);
        return result;
      });
    },
    release() { return coordinateCloudWrite(async () => { capacity.reservations.delete(id); }); },
  };
}

// For other cloud writers that already have complete files ready to publish.
export async function withCloudCapacity<T>(bytes: number, publish: () => Promise<T>): Promise<T> {
  const reservation = await reserveCloudCapacity(bytes);
  try { return await reservation.commit(bytes, publish); }
  finally { await reservation.release(); }
}

