"use client";

import type { DataTableSelection } from "@xos/ui";
import { useMemo, useState, type ReactNode } from "react";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import type { BulkConfig, BulkField, BulkRowRef } from "./types";

/** The bulk bar, its edit dialog and Radix load the first time a row is selected (ADR 0027). */
const barModule = onDemand(() => import("./bulk-bar"));

export interface Bulk {
  /** The DataTable's `selection` prop; undefined when nothing is selectable. */
  readonly selection: DataTableSelection | undefined;
  /** The bar and dialog, rendered after the table. */
  readonly bar: ReactNode;
  /** The properties that change in bulk, for a row's context menu. */
  readonly fields: readonly BulkField[];
  readonly isSelected: (id: string) => boolean;
  readonly toggle: (id: string) => void;
  /**
   * Opens the change dialog for a property from a row's menu: on the whole selection when the row
   * is in it, else on that row alone, which becomes the selection.
   */
  readonly edit: (field: BulkField, id: string) => void;
}

/**
 * Selection and bulk edit for a collection's views (Section 11.7): the selection prop of a DataTable,
 * RecordList, Board or Calendar. The selection keeps only rows the page still shows, so a filter or
 * a live update never leaves a hidden row selected. Without a config (a viewer who may not change the
 * rows) nothing is selectable. With `toolbar: false` (a record's own page, where nothing else is
 * selectable) no bar shows: a change opens from the menu, and closing its dialog clears the row.
 */
export function useBulk(
  config: BulkConfig | null | undefined,
  rows: readonly BulkRowRef[],
  options: { readonly toolbar?: boolean } = {},
): Bulk {
  const toolbar = options.toolbar !== false;
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [field, setField] = useState<BulkField | null>(null);
  const selected = useMemo(() => {
    const shown = new Set(rows.map((r) => r.id));
    return new Set([...picked].filter((id) => shown.has(id)));
  }, [picked, rows]);
  const loaded = useOnDemand(barModule, Boolean(config) && (selected.size > 0 || field !== null));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (!next.delete(id)) next.add(id);
    setPicked(next);
  };
  if (!config) {
    return {
      selection: undefined,
      bar: null,
      fields: [],
      isSelected: () => false,
      toggle: () => undefined,
      edit: () => undefined,
    };
  }
  return {
    selection: { selected, onChange: setPicked },
    bar: loaded ? (
      <loaded.BulkBar
        config={config}
        rows={rows}
        selected={selected}
        field={field}
        onField={(next) => {
          setField(next);
          if (next === null && !toolbar) setPicked(new Set());
        }}
        onClear={() => setPicked(new Set())}
        toolbar={toolbar}
      />
    ) : null,
    fields: config.fields,
    isSelected: (id) => selected.has(id),
    toggle,
    edit: (f, id) => {
      if (!selected.has(id)) setPicked(new Set([id]));
      setField(f);
    },
  };
}
