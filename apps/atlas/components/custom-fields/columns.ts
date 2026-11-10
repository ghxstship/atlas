import type { CustomFieldListView } from "@/lib/custom-fields/types";

/**
 * A list's filterable custom fields as table columns (A117), from the cells the server formatted
 * (lib/custom-fields/server.ts), for client and server tables alike.
 */

/** The column key of a custom field in a table: the filter's `cf.<key>`. */
export function customFieldColumnKey(key: string): string {
  return `cf.${key}`;
}

export interface CustomFieldColumns {
  /** The filterable fields as columns, after the page's own. */
  readonly columns: readonly { readonly key: string; readonly label: string }[];
  /** A row's cells for those columns: display text, or null for no value. */
  readonly cells: (id: string) => Record<string, string | null>;
}

export const NO_CUSTOM_FIELD_COLUMNS: CustomFieldColumns = { columns: [], cells: () => ({}) };

/** A list view's filterable fields as table columns and each row's cells. */
export function customFieldColumns(
  view: CustomFieldListView | null | undefined,
): CustomFieldColumns {
  if (!view || view.fields.length === 0) return NO_CUSTOM_FIELD_COLUMNS;
  const keys = view.fields.map((f) => customFieldColumnKey(f.key));
  return {
    columns: view.fields.map((f, i) => ({ key: keys[i] as string, label: f.label })),
    cells: (id) => {
      const cells = view.cells[id] ?? {};
      return Object.fromEntries(keys.map((key) => [key, cells[key] ?? null]));
    },
  };
}
