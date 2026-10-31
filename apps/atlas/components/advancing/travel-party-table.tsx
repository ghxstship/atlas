"use client";

import { SegmentedControl, StateChip } from "@xos/ui";
import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import type { TravelChip } from "./travel-party";
import { useCopy } from "./use-copy";

export interface TravelPartyRow {
  readonly id: string;
  readonly person: string;
  readonly party: string;
  readonly role: string;
  readonly arrive: string;
  readonly depart: string;
  readonly airports: string;
  readonly travelMissing: boolean;
  readonly room: TravelChip;
  readonly pickup: TravelChip;
  readonly pass: TravelChip;
  readonly assignHref: string;
  readonly pickupHref: string;
}

const FILTERS = ["all", "needsRoom", "needsPickup", "travelMissing"] as const;
type Filter = (typeof FILTERS)[number];

const STATE: Record<TravelChip, "complete" | "proposed" | "deferred" | "blocked"> = {
  assigned: "complete",
  booked: "complete",
  issued: "complete",
  missing: "blocked",
  notNeeded: "deferred",
  notVisible: "deferred",
};

/** Whether a row passes a filter: a room or pickup asked for and not arranged, or no travel request. */
export function passesFilter(row: TravelPartyRow, filter: Filter): boolean {
  if (filter === "needsRoom") return row.room === "missing";
  if (filter === "needsPickup") return row.pickup === "missing";
  if (filter === "travelMissing") return row.travelMissing;
  return true;
}

/**
 * The travel party table (R5, G-175), filtered in the browser over rows the server already read and logged. Row actions
 * open the hospitality forms prefilled; the table offers no export.
 */
export function TravelPartyTable({
  caption,
  rows,
}: {
  caption: string;
  rows: readonly TravelPartyRow[];
}) {
  const t = useCopy("advancing.travelParty");
  const [filter, setFilter] = useState<Filter>("all");
  const shown = rows.filter((r) => passesFilter(r, filter));
  const chip = (c: TravelChip) => <StateChip compact state={STATE[c]} label={t(`chips.${c}`)} />;
  const columns = [
    "person",
    "party",
    "role",
    "arrive",
    "depart",
    "airports",
    "room",
    "pickup",
    "pass",
  ] as const;
  return (
    <div className="flex flex-col gap-8 min-w-0">
      <SegmentedControl
        label={t("filters.label")}
        value={filter}
        options={FILTERS.map((f) => ({ value: f, label: t(`filters.${f}`) }))}
        onChange={(v) => setFilter(v as Filter)}
      />
      <div className="overflow-x-auto rounded-card border border-border-subtle">
        <table className="w-full border-collapse text-text-13">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border-subtle text-start text-text-12 text-text-secondary">
              {columns.map((c) => (
                <th key={c} scope="col" className="px-12 py-6 text-start font-medium">
                  {t(`columns.${c}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-b border-border-subtle last:border-b-0">
                <th scope="row" className="px-12 py-6 text-start font-medium">
                  {r.person}
                </th>
                <td className="px-12 py-6">{r.party}</td>
                <td className="px-12 py-6">{r.role}</td>
                <td className="px-12 py-6">{r.arrive}</td>
                <td className="px-12 py-6">{r.depart}</td>
                <td className="px-12 py-6">{r.airports}</td>
                <td className="px-12 py-6">
                  <span className="flex flex-wrap items-center gap-6">
                    {chip(r.room)}
                    {r.room === "missing" ? (
                      <Link href={r.assignHref as Route} className="text-text-link">
                        {t("actions.assignRoom")}
                      </Link>
                    ) : null}
                  </span>
                </td>
                <td className="px-12 py-6">
                  <span className="flex flex-wrap items-center gap-6">
                    {chip(r.pickup)}
                    {r.pickup === "missing" ? (
                      <Link href={r.pickupHref as Route} className="text-text-link">
                        {t("actions.addPickup")}
                      </Link>
                    ) : null}
                  </span>
                </td>
                <td className="px-12 py-6">{chip(r.pass)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
