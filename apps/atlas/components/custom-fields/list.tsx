"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { CustomFieldListView } from "@/lib/custom-fields/types";
import { customFieldColumns, type CustomFieldColumns } from "./columns";

/**
 * A list page's custom fields (A117): the loader's `customFieldList(...).view(ids)` handed to the collection,
 * which the Add filter control (components/views) and the table's columns read. A page wraps its collection in
 * `<CustomFieldList value={...}>`, or passes the view to a collection component that does.
 */

const CustomFieldListContext = createContext<CustomFieldListView | null>(null);

export function CustomFieldList({
  value,
  children,
}: {
  value: CustomFieldListView | null;
  children: ReactNode;
}) {
  return (
    <CustomFieldListContext.Provider value={value}>{children}</CustomFieldListContext.Provider>
  );
}

/** The list's custom fields, or null outside a list that has filterable ones. */
export function useCustomFieldList(): CustomFieldListView | null {
  return useContext(CustomFieldListContext);
}

/**
 * The list's filterable custom fields as table columns, with each row's cells as display text: append
 * `columns` to the table's own and spread `cells(row.id)` into each row. A view passed in wins over the
 * surrounding list's.
 */
export function useCustomFieldColumns(view?: CustomFieldListView | null): CustomFieldColumns {
  const surrounding = useCustomFieldList();
  const shown = view === undefined ? surrounding : view;
  return useMemo(() => customFieldColumns(shown), [shown]);
}
