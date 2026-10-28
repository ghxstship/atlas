import { savedViewTypeOf, VIEW_REGISTRY, viewCodeOf, type SavedViewType } from "@xos/schemas/views";

/**
 * Saved views and the query string (Section 11.15). Every Atlas collection keeps its view, filters,
 * sort, grouping and search in the URL, so a saved view is that query: `view` becomes the view type,
 * `q` the search, `group` the grouping, `sort` the sort keys (`name,-due` for name ascending then due
 * descending) and every other parameter a filter (`project=NWL` is project eq NWL). The Add filter
 * control's conditions carry their operator after the field (`cf.seats.gte=100`, A117, see conditions.ts),
 * which a saved filter keeps in its own column. Navigation state (the open peek, the create form, the full
 * page) is never saved.
 */

/*
 * How a filter condition is spelled as a query parameter (A117; conditions.ts has the grammar): the field, then
 * the operator after a dot unless it is eq. It lives here because the saved view round trip below, which every
 * collection loads, needs it.
 */

export const CONDITION_OPERATORS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "is_null",
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export function isConditionOperator(value: unknown): value is ConditionOperator {
  return typeof value === "string" && (CONDITION_OPERATORS as readonly string[]).includes(value);
}

/** True for a query parameter the Add filter control writes: a `f.` or `cf.` condition. */
export function isConditionParam(name: string): boolean {
  return name.startsWith("f.") || name.startsWith("cf.");
}

/**
 * A saved view filter's field and operator from a query parameter name: `cf.seats.gte` is field `cf.seats` with
 * gte, and any other name is itself with eq.
 */
export function splitFilterParam(name: string): { field: string; operator: ConditionOperator } {
  const parts = name.split(".");
  const last = parts[parts.length - 1] ?? "";
  if (parts.length === 3 && (parts[0] === "f" || parts[0] === "cf") && isConditionOperator(last)) {
    return { field: `${parts[0]}.${parts[1]}`, operator: last };
  }
  return { field: name, operator: "eq" };
}

/** The query parameter name of a field and operator; the inverse of `splitFilterParam`. */
export function filterParam(field: string, operator: ConditionOperator): string {
  return operator === "eq" ? field : `${field}.${operator}`;
}

/** Query keys that describe where the person is, not what the collection shows. */
export const NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  "peek",
  "full",
  "create",
  "edit",
  "new",
  "tab",
]);

const FIELD = /^[a-z][a-z0-9_.]*$/;
const MAX_VALUE = 1000;
const MAX_SEARCH = 200;
const MAX_SORTS = 10;

export interface ViewQuery {
  readonly viewType: SavedViewType;
  readonly searchText: string | null;
  readonly groupByField: string | null;
  readonly filters: readonly { field: string; operator: ConditionOperator; value: string }[];
  readonly sorts: readonly { field: string; direction: "Ascending" | "Descending" }[];
}

/**
 * The collection key of a page: the path after the org, with project pages keyed by tab rather than
 * project (`/acme/p/NWL/schedule` is `project/schedule`), hyphens as underscores and deeper segments
 * joined, so it satisfies the saved_views key format. Null for a path outside a collection.
 */
export function collectionKeyFor(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean).slice(1);
  if (segments[0] === "p") segments.splice(0, 2, "project");
  const clean = segments
    .map((s) => s.toLowerCase().replace(/-/g, "_"))
    .filter((s) => /^[a-z][a-z0-9_]*$/.test(s));
  if (clean.length === 0 || clean.length !== segments.length) return null;
  const [first, ...rest] = clean;
  return rest.length > 0 ? `${first}/${rest.join("_")}` : (first as string);
}

/** The saved query of the page's current URL, with the view on screen. */
export function queryToView(search: URLSearchParams, currentView: string): ViewQuery {
  const filters: { field: string; operator: ConditionOperator; value: string }[] = [];
  const seen = new Set<string>();
  for (const [key, value] of search.entries()) {
    if (["view", "q", "group", "sort"].includes(key) || NAVIGATION_KEYS.has(key)) continue;
    if (!FIELD.test(key) || seen.has(key) || value === "" || value.length > MAX_VALUE) continue;
    seen.add(key);
    filters.push({ ...splitFilterParam(key), value });
  }
  const sorts = (search.get("sort") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) =>
      s.startsWith("-")
        ? { field: s.slice(1), direction: "Descending" as const }
        : { field: s, direction: "Ascending" as const },
    )
    .filter((s) => FIELD.test(s.field))
    .slice(0, MAX_SORTS);
  const q = search.get("q")?.trim() ?? "";
  const group = search.get("group") ?? "";
  return {
    viewType: savedViewTypeOf(VIEW_REGISTRY, currentView) ?? "List",
    searchText: q === "" ? null : q.slice(0, MAX_SEARCH),
    groupByField: FIELD.test(group) ? group : null,
    filters,
    sorts,
  };
}

/**
 * The query string that opens a saved view on its page: the view code that saves as the view's type
 * among the page's offered views (the page default when none matches), then search, grouping, sorts
 * and filters.
 */
export function viewToQuery(
  view: {
    readonly viewType: SavedViewType;
    readonly searchText: string | null;
    readonly groupByField: string | null;
    readonly filters: readonly {
      field: string;
      /** A saved filter's operator; one the Add filter control does not write is read as eq. */
      operator?: string;
      value: string | null;
    }[];
    readonly sorts: readonly { field: string; direction: "Ascending" | "Descending" }[];
  },
  offered: readonly string[],
): string {
  const next = new URLSearchParams();
  const code = viewCodeOf(VIEW_REGISTRY, view.viewType, offered);
  if (code) next.set("view", code);
  for (const f of view.filters) {
    const operator = isConditionOperator(f.operator) ? f.operator : "eq";
    // An is_null filter saved without a value (as the API may store it) means "is empty".
    const value = f.value ?? (operator === "is_null" ? "true" : null);
    if (value !== null) next.set(filterParam(f.field, operator), value);
  }
  if (view.searchText) next.set("q", view.searchText);
  if (view.groupByField) next.set("group", view.groupByField);
  if (view.sorts.length > 0) {
    next.set(
      "sort",
      view.sorts.map((s) => (s.direction === "Descending" ? `-${s.field}` : s.field)).join(","),
    );
  }
  return next.toString();
}

/** A query string in a comparable form: keys sorted, navigation keys and blanks dropped. */
export function canonicalQuery(query: string): string {
  return [...new URLSearchParams(query).entries()]
    .filter(([k, v]) => !NAVIGATION_KEYS.has(k) && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("&");
}

/** The current URL as the saved query it would store, in canonical form. */
export function currentQuery(
  search: URLSearchParams,
  currentView: string,
  offered: readonly string[],
): string {
  return canonicalQuery(viewToQuery(queryToView(search, currentView), offered));
}

/** True when the URL carries no collection state, so the person's default view may open. */
export function isBareQuery(search: URLSearchParams): boolean {
  return [...search.keys()].every((k) => NAVIGATION_KEYS.has(k));
}
