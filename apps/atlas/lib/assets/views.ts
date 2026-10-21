import type { AssetState } from "@xos/data/assets";
import type { RecordState } from "@xos/ui";

/**
 * View helpers for the assets pages. View types per page come from the sitemap (`list.views`), the
 * single source of navigation (Section 3.15); this module only parses the query string against
 * them and maps asset states to the icon tone the shared components draw.
 */

export const ASSET_VIEWS = [
  "table",
  "list",
  "board",
  "gallery",
  "calendar",
  "resource-schedule",
] as const;
export type AssetView = (typeof ASSET_VIEWS)[number];

export function isAssetView(value: string): value is AssetView {
  return (ASSET_VIEWS as readonly string[]).includes(value);
}

/** The view a page shows: the query string's when the page offers it, else the default. */
export function pickView(
  requested: string | undefined,
  offered: readonly string[],
  fallback: string,
): AssetView {
  const wanted = requested && offered.includes(requested) ? requested : fallback;
  return isAssetView(wanted) ? wanted : "table";
}

/**
 * The icon tone of each asset state. Shared components (StateIcon, Calendar, ResourceSchedule) draw
 * the nine record states; an asset state borrows the tone that reads the same way, and its label
 * always comes from the assets catalog, so no asset is ever called by a record state's name.
 */
export const ASSET_STATE_TONE: Record<AssetState, RecordState> = {
  Proposed: "proposed",
  Received: "ready",
  Available: "ready",
  Reserved: "scheduled",
  Deployed: "active",
  "In Maintenance": "in-review",
  Damaged: "blocked",
  Lost: "blocked",
  Retired: "canceled",
};

/** Query string values a list route keeps across view switches (Section 4.5.3). */
export interface ListQuery {
  readonly view?: string;
  readonly filter?: string;
  readonly q?: string;
  readonly peek?: string;
  readonly full?: string;
}

export function readQuery(search: Record<string, string | string[] | undefined>): ListQuery {
  const one = (key: string) => {
    const value = search[key];
    return typeof value === "string" ? value : undefined;
  };
  const query: Record<string, string> = {};
  for (const key of ["view", "filter", "q", "peek", "full"]) {
    const value = one(key);
    if (value !== undefined) query[key] = value;
  }
  return query;
}

/** Case-insensitive match of a free-text search against a row's searchable text. */
export function matches(q: string | undefined, ...values: (string | null | undefined)[]): boolean {
  if (!q) return true;
  const needle = q.trim().toLocaleLowerCase();
  return values.some((v) => v?.toLocaleLowerCase().includes(needle));
}

const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface KeyedRow {
  readonly key: string;
  readonly peek?: string;
  readonly recordKey?: string;
  readonly title: string;
}

/** The key column: the row's human key, else its peek value unless that is a row id (A59-009). */
export function displayKey(row: KeyedRow): string {
  if (row.recordKey !== undefined) return row.recordKey;
  const fallback = row.peek ?? row.key;
  return ROW_ID.test(fallback) ? "" : fallback;
}

/** The title with its human key in front, for views without a key column (board, gallery, calendar). */
export function keyedTitle(row: KeyedRow): string {
  return row.recordKey ? `${row.recordKey} · ${row.title}` : row.title;
}
