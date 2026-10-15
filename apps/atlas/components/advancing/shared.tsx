import type { AdvanceParty, PacketState } from "@xos/data/advancing";
import type { RecordState } from "@xos/ui";
import type { ReactNode } from "react";
import type { Translate } from "@/lib/shell/translate";
import { InlineAlert } from "./ui";

/** Board columns and chips for the derived packet states, in lifecycle order. */
export const PACKET_RECORD_STATE: Readonly<Record<PacketState, RecordState>> = {
  Draft: "proposed",
  Awaiting: "active",
  Overdue: "blocked",
  InReview: "in-review",
  Complete: "complete",
};

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

/**
 * Comments and attachments arrive with A18's unified comment and attachment service; until then
 * each record page names the feature and why it is not here yet, instead of an empty box.
 */
export function BlockedPanels({ t }: { t: Translate }) {
  return (
    <div className="flex flex-col gap-8">
      <InlineAlert tone="info" title={t("advancing.blocked.commentsTitle")}>
        {t("advancing.blocked.comments")}
      </InlineAlert>
      <InlineAlert tone="info" title={t("advancing.blocked.attachmentsTitle")}>
        {t("advancing.blocked.attachments")}
      </InlineAlert>
    </div>
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
