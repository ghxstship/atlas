/**
 * Queued writes the server settled without them (B8, ADR 0147): the uploader drops such a write
 * as done, and the offline queue says so in one informational line instead of an error. A gate override queued after
 * an offline denial is the case today: the server decides the scan at upload, may grant it, and then refuses the
 * override with scan_not_denied, which means nobody needed letting in. Kept in memory for the session; a line is
 * dismissed when read.
 */

/** Refusal rules that mean the write was not needed, keyed by the queued target, to the line the queue shows. */
export const SETTLED_RULES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  override_access_scan: { scan_not_denied: "settledScanNotDenied" },
  "app.override_access_scan": { scan_not_denied: "settledScanNotDenied" },
};

export interface SettledNote {
  readonly id: string;
  /** Key under compass.queue. */
  readonly key: string;
  readonly at: number;
}

let notes: readonly SettledNote[] = [];
const listeners = new Set<() => void>();

/** The line for a refusal of a queued target, when that refusal means the write was not needed. */
export function settledKey(target: string, rule: string | null | undefined): string | null {
  return rule ? (SETTLED_RULES[target]?.[rule] ?? null) : null;
}

export function addSettledNote(id: string, key: string, at: number = Date.now()): void {
  notes = [...notes.filter((n) => n.id !== id), { id, key, at }];
  for (const listener of listeners) listener();
}

export function dismissSettledNote(id: string): void {
  notes = notes.filter((n) => n.id !== id);
  for (const listener of listeners) listener();
}

export function settledNotes(): readonly SettledNote[] {
  return notes;
}

export function subscribeSettledNotes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
