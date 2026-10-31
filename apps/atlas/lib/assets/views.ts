import type { AssetState } from "@xos/data/assets";
import type { RecordState } from "@xos/ui";
import {
  conditionsOf,
  matchesShown,
  type Condition,
  type ConditionOperator,
} from "@/lib/views/conditions";

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
  Returned: "canceled",
};

/**
 * The units list's declared filter fields (A117), matched on the unit's stored values rather than the words shown,
 * so a view saved in one language opens the same in the other: `f.state` is its asset state and `f.acquisition`
 * Purchase or Rental (from app.asset_unit_hire, Rental when it arrived on a rental order line).
 */
export const UNIT_FILTER_FIELDS = ["state", "acquisition"] as const;
export type UnitFilterField = (typeof UNIT_FILTER_FIELDS)[number];

/** What the units list's conditions read of a unit. */
export interface UnitViewFacts {
  readonly state: AssetState;
  readonly acquisitionKind: "Purchase" | "Rental";
}

/**
 * The built-in views of the units list (R7a, G-96), listed first in the saved views menu under Built-in: presets
 * in the A117 filter model, so their conditions show as filter chips, no one edits or deletes them, and a person
 * saves a copy as their own saved view. Each name is the catalog key `assets.views.builtIn.<id>`.
 */
export const BUILT_IN_UNIT_PRESETS: readonly {
  readonly id: "damaged" | "hiredIn" | "unavailable";
  readonly filters: readonly Condition[];
}[] = [
  { id: "damaged", filters: [{ scope: "field", key: "state", operator: "eq", value: "Damaged" }] },
  {
    id: "hiredIn",
    filters: [
      { scope: "field", key: "acquisition", operator: "eq", value: "Rental" },
      { scope: "field", key: "state", operator: "ne", value: "Returned" },
    ],
  },
  {
    id: "unavailable",
    filters: [{ scope: "field", key: "state", operator: "ne", value: "Available" }],
  },
];

/** A preset's conditions as saved view filters (`f.state`, `ne`, `Available`). */
export function presetFilters(
  conditions: readonly Condition[],
): { field: string; operator: ConditionOperator; value: string }[] {
  return conditions.map((c) => ({ field: `f.${c.key}`, operator: c.operator, value: c.value }));
}

/** The query's conditions on the units list's declared fields. */
export function unitConditions(conditions: string | undefined): Condition[] {
  return conditionsOf(new URLSearchParams(conditions ?? "")).filter(
    (c) => c.scope === "field" && (UNIT_FILTER_FIELDS as readonly string[]).includes(c.key),
  );
}

/** True when a unit passes every condition on the declared fields. */
export function unitMatches(conditions: readonly Condition[], unit: UnitViewFacts): boolean {
  return conditions.every((c) =>
    matchesShown(c.key === "acquisition" ? unit.acquisitionKind : unit.state, c),
  );
}

/** Query string values a list route keeps across view switches (Section 4.5.3). */
export interface ListQuery {
  readonly view?: string;
  readonly filter?: string;
  readonly q?: string;
  readonly peek?: string;
  readonly full?: string;
  /** The Add filter control's conditions (`f.*`, `cf.*`, A117), as a query string. */
  readonly conditions?: string;
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
  const conditions = new URLSearchParams();
  for (const key of Object.keys(search)) {
    const value = one(key);
    if (value !== undefined && /^c?f\./.test(key)) conditions.set(key, value);
  }
  if (conditions.size > 0) query["conditions"] = conditions.toString();
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
