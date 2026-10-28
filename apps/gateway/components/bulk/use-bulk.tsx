"use client";

import type { DataTableSelection } from "@xos/ui";
import { useMemo, useState, type ReactNode } from "react";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import type { GatewayActionId } from "@/lib/bulk/catalog";

/** The bulk bar, its dialog and Radix load the first time a row is selected (ADR 0027). */
const barModule = onDemand(() => import("./bulk-bar"));

/** A selectable row: its id, the name menus and refusals use, and whether the action applies to it. */
export interface BulkRowRef {
  readonly id: string;
  readonly label: string;
  readonly eligible: boolean;
}

export interface Bulk {
  /** The DataTable's `selection` prop; undefined when the list has no action to take in bulk. */
  readonly selection: DataTableSelection | undefined;
  /** The bar and dialog, rendered after the table. */
  readonly bar: ReactNode;
  readonly action: GatewayActionId | null;
  readonly isSelected: (id: string) => boolean;
  readonly toggle: (id: string) => void;
  /**
   * Takes the action from a row's menu: on the whole selection when the row is in it, else on that
   * row alone, which becomes the selection.
   */
  readonly act: (id: string) => void;
}

/**
 * Selection and bulk actions for a Gateway collection's table (Section 11.7, ADR 0082), as Atlas's
 * useBulk: the selection keeps only rows the page still shows, so a live update never leaves a
 * hidden row selected. A list whose rows have no action to take in bulk selects nothing.
 */
export function useBulk(action: GatewayActionId | null, rows: readonly BulkRowRef[]): Bulk {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => {
    const shown = new Set(rows.map((r) => r.id));
    return new Set([...picked].filter((id) => shown.has(id)));
  }, [picked, rows]);
  const loaded = useOnDemand(barModule, action !== null && (selected.size > 0 || open));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (!next.delete(id)) next.add(id);
    setPicked(next);
  };
  if (action === null) {
    return {
      selection: undefined,
      bar: null,
      action: null,
      isSelected: () => false,
      toggle: () => undefined,
      act: () => undefined,
    };
  }
  return {
    selection: { selected, onChange: setPicked },
    bar: loaded ? (
      <loaded.BulkBar
        action={action}
        rows={rows}
        selected={selected}
        open={open}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
        onClear={() => setPicked(new Set())}
      />
    ) : null,
    action,
    isSelected: (id) => selected.has(id),
    toggle,
    act: (id) => {
      if (!selected.has(id)) setPicked(new Set([id]));
      setOpen(true);
    },
  };
}
