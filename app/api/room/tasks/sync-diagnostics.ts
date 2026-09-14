export type SyncAttempt = {
  id: string; editId: string; at: number; finishedAt?: number; stage: string; error?: string;
  requested: ReturnType<typeof taskSyncEvidence>;
  versionRefreshed?: boolean;
  target?: { owner: string; id: string; expectedVersion: string; observedVersion: string; differences: string[]; current: ReturnType<typeof taskSyncEvidence> };
  provider?: string;
};

export type DeletionSideEvidence = {
  side: 'source' | 'target'; owner: string; taskId?: string; projectId?: string;
  role: 'original' | 'legacy-publisher-copy' | 'claimant-copy' | 'no-publisher-copy';
  outcome: 'skipped' | 'absent' | 'deleted' | 'present' | 'later-occurrence' | 'lookup-failed' | 'delete-failed';
  current?: ReturnType<typeof taskSyncEvidence>; error?: string; provider?: string;
};
export type DeletionDiagnostic = {
  at: number; origin: 'delete-request' | 'legacy-unverified'; pending?: boolean;
  sides: DeletionSideEvidence[]; verifiedAt?: number; verification?: DeletionSideEvidence[];
  checks?: number; nextCheckAt?: number;
};

// Retain only identifiers and date/priority values needed to diagnose writes.
// Task bodies, headers, tokens and provider-specific metadata are excluded.
export function taskSyncEvidence(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const task = value as Record<string, unknown>;
  return Object.fromEntries(['id', 'projectId', 'etag', 'status', 'startDate', 'dueDate', 'isAllDay', 'timeZone', 'priority'].map(key => {
    const field = task[key];
    return [key, typeof field === 'string' ? field.slice(0, 160) : typeof field === 'number' || typeof field === 'boolean' ? field : null];
  }));
}

export function appendSyncAttempt(previous: SyncAttempt[], attempt: SyncAttempt): SyncAttempt[] {
  const all = [...previous, attempt];
  if (all.length <= 6) return all;
  const first = all.find(item => item.error) || all[0];
  return [first, ...all.slice(-5).filter(item => item.id !== first.id)];
}
