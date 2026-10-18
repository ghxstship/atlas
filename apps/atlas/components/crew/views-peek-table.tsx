"use client";

import { DataTable, type DataTableColumn } from "@xos/ui";
import { useRouter } from "next/navigation";
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
}) {
  const router = useRouter();
  const href = useQueryHref();
  return (
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
    />
  );
}
