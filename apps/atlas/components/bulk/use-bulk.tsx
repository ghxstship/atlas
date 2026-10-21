"use client";

import type { DataTableSelection } from "@xos/ui";
import { useMemo, useState, type ReactNode } from "react";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import type { BulkConfig, BulkRowRef } from "./types";

/** The bulk bar, its edit dialog and Radix load the first time a row is selected (ADR 0027). */
const barModule = onDemand(() => import("./bulk-bar"));

/**
 * Selection and bulk edit for a collection's DataTable (Section 11.7). Returns the table's
 * `selection` prop and the bar to render after the table. The selection keeps only rows the page
 * still shows, so a filter or a live update never leaves a hidden row selected. Without a config
 * (a viewer who may not change the rows) nothing is selectable.
 */
export function useBulk(
  config: BulkConfig | null | undefined,
  rows: readonly BulkRowRef[],
): { selection: DataTableSelection | undefined; bar: ReactNode } {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const selected = useMemo(() => {
    const shown = new Set(rows.map((r) => r.id));
    return new Set([...picked].filter((id) => shown.has(id)));
  }, [picked, rows]);
  const loaded = useOnDemand(barModule, Boolean(config) && selected.size > 0);
  if (!config) return { selection: undefined, bar: null };
  return {
    selection: { selected, onChange: setPicked },
    // Once loaded the bar stays mounted, so its Undo toast outlives the selection it changed.
    bar: loaded ? (
      <loaded.BulkBar
        config={config}
        rows={rows}
        selected={selected}
        onClear={() => setPicked(new Set())}
      />
    ) : null,
  };
}
