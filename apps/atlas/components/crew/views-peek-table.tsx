"use client";

import { DataTable, type DataTableColumn } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import type { BulkConfig } from "@/components/bulk/types";
import { useBulk } from "@/components/bulk/use-bulk";
import { useQueryHref } from "./views.shared";

/** A table whose rows open the side peek (Enter on a cell or a double click). */
export function PeekTable(props: {
  caption: string;
  columns: DataTableColumn[];
  rows: Array<Record<string, unknown> & { id: string }>;
  totals?: Record<string, unknown>;
  totalsLabel?: string;
  /** False for tables inside a record, whose rows open nothing. */
  activatable?: boolean;
  /** Bulk edit of a selection (Section 11.7); each row names itself in its `label` field. */
  bulk?: BulkConfig | null;
}) {
  const router = useRouter();
  const href = useQueryHref();
  const refs = useMemo(
    () => props.rows.map((r) => ({ id: r.id, label: String(r["label"] ?? r.id) })),
    [props.rows],
  );
  const { selection, bar } = useBulk(props.bulk, refs);
  return (
    <>
      <DataTable
        caption={props.caption}
        columns={props.columns}
        rows={props.rows}
        {...(props.totals ? { totals: props.totals } : {})}
        {...(props.totalsLabel ? { totalsLabel: props.totalsLabel } : {})}
        {...(props.activatable === false
          ? {}
          : {
              onRowActivate: (row: Record<string, unknown>) =>
                router.push(href({ peek: String(row["id"]), full: null })),
            })}
        {...(selection ? { selection } : {})}
      />
      {bar}
    </>
  );
}
