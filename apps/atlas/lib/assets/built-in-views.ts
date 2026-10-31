import {
  canonicalQuery,
  currentQuery,
  queryToView,
  viewToQuery,
  type FilterPreset,
} from "@/lib/views/query";

/** A built-in view as the saved views menu lists it: the query it opens and whether it is on screen. */
export interface BuiltInViewEntry {
  readonly preset: FilterPreset;
  readonly query: string;
  readonly active: boolean;
}

/**
 * The units list's built-in views (R7a, G-96) for the saved views menu. A preset applies its filters on the view
 * type on screen, and is on screen when the URL holds exactly its query. The assets collection works this out and
 * hands CollectionViews plain menu items, so the switcher every collection loads gains nothing for them.
 */
export function builtInViewEntries(
  presets: readonly FilterPreset[],
  search: URLSearchParams,
  view: string,
  offered: readonly string[],
): BuiltInViewEntry[] {
  const here = currentQuery(search, view, offered);
  return presets.map((preset) => {
    const query = viewToQuery(
      { ...queryToView(new URLSearchParams(), view), filters: preset.filters },
      offered,
    );
    return { preset, query, active: canonicalQuery(query) === here };
  });
}
