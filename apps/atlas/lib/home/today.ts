import type { TodayChange } from "@xos/data/change-tracking";
import { isActionableApproval, type InboxItem } from "@xos/data/inbox";
import { recordFieldLabelKey } from "@/components/work/record-history-items";
import { historyLabelKey } from "@/lib/history/fields";

/**
 * Home > Today's tiles (B6, G-249): the doors countdown, the approvals waiting for the viewer and
 * what others changed since their last visit. Pure, so the wording is unit tested; the page and
 * components/home/doors-countdown.tsx render it.
 */

/** How long after doors open the tile still counts up, as nextDoors (packages/data home.ts) looks back. */
export const DOORS_OPEN_WINDOW_MS = 6 * 3_600_000;

export type DoorsText =
  | { readonly key: "home.today.tiles.doors.in"; readonly hours: number; readonly minutes: number }
  | {
      readonly key: "home.today.tiles.doors.opened";
      readonly hours: number;
      readonly minutes: number;
    }
  | { readonly key: "home.today.tiles.doors.none" };

/** "Doors in 2 h 14 min" before they open, "Doors opened 40 min ago" for six hours after. */
export function doorsText(doorsAt: string | null, now: Date): DoorsText {
  if (!doorsAt) return { key: "home.today.tiles.doors.none" };
  const delta = Date.parse(doorsAt) - now.getTime();
  if (Number.isNaN(delta) || -delta > DOORS_OPEN_WINDOW_MS)
    return { key: "home.today.tiles.doors.none" };
  const total = Math.floor(Math.abs(delta) / 60_000);
  const parts = { hours: Math.floor(total / 60), minutes: total % 60 };
  return delta > 0
    ? { key: "home.today.tiles.doors.in", ...parts }
    : { key: "home.today.tiles.doors.opened", ...parts };
}

/** The approvals waiting for the viewer, as the Inbox's Needs You section counts them. */
export function waitingApprovals(items: readonly InboxItem[]): InboxItem[] {
  return items.filter(isActionableApproval);
}

/**
 * The catalog keys naming a change's fields: a record's fields by its form labels and its kind
 * attributes by theirs (as its history words them), a shift's from the shared column dictionary.
 * A field with no label is left out; `has` tells whether a key is in the catalog.
 */
export function changeFieldKeys(change: TodayChange, has: (key: string) => boolean): string[] {
  const keyOf = change.table === "app.records" ? recordFieldLabelKey : historyLabelKey;
  return change.fields.flatMap((f) => {
    const key = keyOf(f);
    return key !== null && has(key) ? [key] : [];
  });
}
