/**
 * Presence on records, peeks and documents (Section 11.7, ADR 0083), independent of React and the
 * network so it can be tested. A row of a table in private.presence_subjects (2170) has its own
 * private Realtime channel; Realtime lets only people who can read the row join it, and keeps who is
 * there in memory, never in the database.
 */

/** Tables whose rows show presence: private.presence_subjects in 2170, without the `app.` prefix. */
export const PRESENCE_TABLES = [
  "records",
  "documents",
  "sops",
  "incidents",
  "purchase_orders",
  "goods_receipts",
  "rfqs",
  "vendors",
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

/** What a tab tracks on the channel. */
export function presenceState(me: PresenceMe): Record<string, string> {
  return { key: me.key, name: me.name };
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
