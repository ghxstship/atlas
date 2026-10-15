import { getNode } from "@xos/ia";
import type { RecordState } from "@xos/ui";
import { sitemap } from "@/lib/shell/sitemap";

/**
 * View selection for the Places and Safety collections (Section 11.15). The view types a page may
 * offer come from its sitemap node (`list.views`, the single source until A31 publishes
 * packages/schemas/views.yaml); a view whose data condition fails is never offered, so a switcher
 * never shows a disabled option. The view lives in the query string so it survives reloads and keeps
 * filter, sort and search state when it changes.
 */

export type ViewType =
  | "list"
  | "table"
  | "map"
  | "gallery"
  | "tree"
  | "site-plan"
  | "board"
  | "calendar";

export interface ViewChoice {
  readonly offered: readonly ViewType[];
  readonly current: ViewType;
}

/**
 * The views a node offers for the data on screen and the one to show. `fits` names the data
 * condition of each view that has one; a missing entry means the view always fits (list, table).
 */
export function chooseView(
  nodeId: string,
  requested: string | undefined,
  fits: Partial<Record<ViewType, boolean>>,
): ViewChoice {
  const list = getNode(sitemap, nodeId).node.list;
  const declared = (list?.views ?? ["list"]) as ViewType[];
  const offered = declared.filter((v) => fits[v] ?? true);
  const fallback = offered.includes(list?.default as ViewType)
    ? (list?.default as ViewType)
    : (offered[0] ?? "list");
  const current = offered.includes(requested as ViewType) ? (requested as ViewType) : fallback;
  return { offered: offered.length > 0 ? offered : ["list"], current };
}

/** The design system's state token for a canon record state ("In Review" to "in-review"). */
export function recordStateToken(state: string): RecordState {
  return state.toLowerCase().replace(/\s+/g, "-") as RecordState;
}

/** A query string value, taking the first when a key repeats. */
export function param(
  search: Readonly<Record<string, string | string[] | undefined>>,
  key: string,
): string | undefined {
  const value = search[key];
  return Array.isArray(value) ? value[0] : value;
}

/** An href on the same path with some query keys set or removed (undefined removes). */
export function withQuery(
  path: string,
  search: Readonly<Record<string, string | string[] | undefined>>,
  changes: Readonly<Record<string, string | undefined>>,
): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    const v = Array.isArray(value) ? value[0] : value;
    if (v !== undefined && !(key in changes)) next.set(key, v);
  }
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) next.set(key, value);
  }
  const query = next.toString();
  return query ? `${path}?${query}` : path;
}

/** Case-insensitive match of a search term against any of the given fields. */
export function matchesSearch(term: string | undefined, ...fields: (string | null)[]): boolean {
  const needle = term?.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => f !== null && f.toLowerCase().includes(needle));
}
