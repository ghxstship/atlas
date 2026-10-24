import type { AdvanceParty, PacketState } from "@xos/data/advancing";
import type { RecordState } from "@xos/ui";
import type { ReactNode } from "react";
import type { Translate } from "@/lib/shell/translate";

/** Board columns and chips for the derived packet states, in lifecycle order. */
export const PACKET_RECORD_STATE: Readonly<Record<PacketState, RecordState>> = {
  Draft: "proposed",
  Awaiting: "active",
  Overdue: "blocked",
  InReview: "in-review",
  Complete: "complete",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a `?peek` key has the shape of an advancing row id (a UUID). A key without it (a record
 * key from elsewhere) names no packet, rider, run, guest or submission, so the page hands it to the
 * shell's peek; an id with no row still answers the page's own 404.
 */
export function isRowId(key: string): boolean {
  return UUID.test(key);
}

/** Search params flattened to their first value. */
export type Search = Readonly<Record<string, string>>;

export function flatSearch(raw: Record<string, string | string[] | undefined>): Search {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) out[key] = first;
  }
  return out;
}

/** The URL of the current page with some query keys set or removed. */
export function withQuery(path: string, search: Search, changes: Record<string, string | null>) {
  const next = new URLSearchParams(search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  const query = next.toString();
  return query ? `${path}?${query}` : path;
}

/** A view from the query string when the page offers it, else the page's default. */
export function pickView(search: Search, views: readonly string[], fallback: string): string {
  const asked = search["view"];
  return asked && views.includes(asked) ? asked : fallback;
}

/** A party's display name; a hidden name reads as its kind, never blank. */
export function partyLabel(party: AdvanceParty, t: Translate): string {
  return (
    party.name ??
    t(party.kind === "person" ? "advancing.common.person" : "advancing.common.counterparty")
  );
}

/** One label and value in a record's property column. */
export function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 py-6">
      <dt className="text-text-12 text-text-secondary">{label}</dt>
      <dd className="m-0 text-text-13 text-text-primary">{children}</dd>
    </div>
  );
}
