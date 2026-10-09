import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyClassroomAction, CLASSROOM_DEVICE_FONT, type ClassroomAction, type ClassroomProfile } from '../../classroom-members.ts';

export type UserRecord = {
  nickname?: string;
  activity?: string;
  todoNote?: string;
  ticktickToken?: string;
  updatedAt: string;
};

type IdentityStore = {
  version: 1;
  users: Record<string, UserRecord>;
  classroom?: { seats: string[] };
};

const dataDirectory = process.env.DATA_DIR
  || (process.env.NODE_ENV === "production" ? "/data" : path.join(process.cwd(), ".data"));
const storePath = path.join(/* turbopackIgnore: true */ dataDirectory, "identities.json");
let writeQueue: Promise<void> = Promise.resolve();

const emptyStore = (): IdentityStore => ({ version: 1, users: {} });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCompatibleStore(value: unknown): value is IdentityStore {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.users)) return false;
  if (!Object.values(value.users).every(user => isRecord(user)
    && ["nickname", "activity", "todoNote", "ticktickToken", "updatedAt"].every(key => user[key] === undefined || typeof user[key] === "string"))) return false;
  // Historical v1 files may omit timestamps and retain retired classroom fields.
  return value.classroom === undefined || (isRecord(value.classroom) && Array.isArray(value.classroom.seats)
    && value.classroom.seats.every(seat => typeof seat === "string"));
}

async function readStore(): Promise<IdentityStore> {
  try {
    const parsed: unknown = JSON.parse(await readFile(storePath, "utf8"));
    if (!isCompatibleStore(parsed)) throw new Error("Unsupported identity store format");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeStore(store: IdentityStore): Promise<void> {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, storePath);
  } finally { await rm(temporaryPath, { force: true }).catch(() => undefined); }
}

export async function getUser(identityId: string): Promise<UserRecord | null> {
  await writeQueue;
  return (await readStore()).users[identityId] || null;
}

export async function listRoomMembers() {
  await writeQueue;
  return Object.entries((await readStore()).users).map(([id, user]) => ({ id, name: user.nickname || "成员" }));
}

function classroomProfileFromStore(store: IdentityStore): ClassroomProfile {
  const members = Object.entries(store.users).map(([id, user]) => ({ id, name: user.nickname || '成员', activity: user.activity || '', todoNote: user.todoNote || '' }));
  const available = new Set(members.map(member => member.id));
  const seats = [...new Set([...(store.classroom?.seats || []), ...members.map(member => member.id)])].filter(id => available.has(id)).slice(0, 2);
  return { members, seats, font: CLASSROOM_DEVICE_FONT };
}

export async function getClassroomProfile() {
  await writeQueue;
  return classroomProfileFromStore(await readStore());
}

export function updateClassroomProfile(identityId: string, action: ClassroomAction) {
  let result: ClassroomProfile;
  const operation = writeQueue.then(async () => {
    const store = await readStore();
    result = applyClassroomAction(classroomProfileFromStore(store), identityId, action);
    store.classroom = { seats: result.seats };
    await writeStore(store);
  });
  writeQueue = operation.catch(() => undefined);
  return operation.then(() => result!);
}

export function updateUser(identityId: string, update: (current: UserRecord | null) => UserRecord): Promise<UserRecord> {
  let result: UserRecord;
  const operation = writeQueue.then(async () => {
    const store = await readStore();
    result = update(store.users[identityId] || null);
    store.users[identityId] = result;
    await writeStore(store);
  });
  writeQueue = operation.catch(() => undefined);
  return operation.then(() => result!);
}
