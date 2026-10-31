/**
 * Presence on records, peeks and documents (Section 11.7, ADR 0083), independent of React and the
 * network so it can be tested. A row of a table in private.presence_subjects (2170) has its own
 * private Realtime channel; Realtime lets only people who can read the row join it, and keeps who is
 * there in memory, never in the database.
 */

/**
 * Tables whose rows show presence: private.presence_subjects (2170, and app.budgets from 2811),
 * without the `app.` prefix.
 */
export const PRESENCE_TABLES = [
  "records",
  "documents",
  "sops",
  "incidents",
  "purchase_orders",
  "goods_receipts",
  "rfqs",
  "vendors",
  "budgets",
] as const;

export type PresenceTable = (typeof PRESENCE_TABLES)[number];

/** The person this tab tracks: their person id (one entry for all their tabs) and display name. */
export interface PresenceMe {
  readonly key: string;
  readonly name: string;
}

/** The channel of one row, as 2170's join rule reads it: `presence:<table>:<row id>`. */
export function presenceTopic(table: PresenceTable, id: string): string {
  return `presence:${table}:${id}`;
}

/**
 * What a tab tracks on the channel. A budget grid adds the line number of the cell this tab has open,
 * so the others see who is editing which line.
 */
export function presenceState(
  me: PresenceMe,
  extra?: { readonly line: number },
): Record<string, string | number> {
  return extra ? { key: me.key, name: me.name, line: extra.line } : { key: me.key, name: me.name };
}

/** Another person on a budget, and the line they have open (null while they only look). */
export interface OtherEditor {
  /** The person's presence key: two people can share a display name. */
  readonly key: string;
  readonly name: string;
  readonly line: number | null;
}

/**
 * The other people present, once each by name order, with the line each has open: a person with two
 * tabs shows the line of whichever tab has a cell open. This tab's person is left out.
 */
export function othersEditing(
  members: readonly Record<string, unknown>[],
  meKey: string,
): readonly OtherEditor[] {
  const people = new Map<string, OtherEditor>();
  for (const member of members) {
    const key = member["key"];
    const name = member["name"];
    if (typeof key !== "string" || key === meKey || typeof name !== "string" || !name.trim()) {
      continue;
    }
    const raw = member["line"];
    const line = typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : null;
    const known = people.get(key);
    people.set(key, { key, name: name.trim(), line: known?.line ?? line });
  }
  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The other people present, by name, once each and in a stable order: Realtime lists every tab, so
 * a person with two tabs open appears twice, and this tab's person is left out.
 */
export function othersPresent(
  members: readonly Record<string, unknown>[],
  meKey: string,
): readonly string[] {
  const names = new Map<string, string>();
  for (const member of members) {
    const key = member["key"];
    const name = member["name"];
    if (typeof key !== "string" || key === meKey || typeof name !== "string" || !name.trim()) {
      continue;
    }
    names.set(key, name.trim());
  }
  return [...new Set(names.values())].sort((a, b) => a.localeCompare(b));
}
