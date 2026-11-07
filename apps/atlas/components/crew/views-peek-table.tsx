"use client";

import { DataTable, type DataTableColumn } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import type { BulkConfig } from "@/components/bulk/types";
import { useBulk } from "@/components/bulk/use-bulk";
import { useHoverCards, type RecordPreview } from "@/components/hover/use-hover-cards";
import { useRowMenu } from "@/components/menus/use-row-menu";
import { useQueryHref } from "./views.shared";

/**
 * A table whose rows open the side peek (Enter on a cell or a double click). A row with a `preview`
 * shows it as a hover card on its first column after 400 ms (Section 11.7).
 */
export function PeekTable(props: {
  caption: string;
  columns: DataTableColumn[];
  rows: Array<Record<string, unknown> & { id: string; preview?: RecordPreview }>;
  totals?: Record<string, unknown>;
  totalsLabel?: string;
  /** False for tables inside a record, whose rows open nothing. */
  activatable?: boolean;
  /**
   * Bulk edit of a selection (Section 11.7); each row names itself in its `label` field and may carry the version it
   * was read at in `version`, which the change is sent against.
   */
  bulk?: BulkConfig | null;
}) {
  const router = useRouter();
  const href = useQueryHref();
  const refs = useMemo(
    () =>
      props.rows.map((r) => ({
        id: r.id,
        label: String(r["label"] ?? r.id),
        ...(typeof r["version"] === "string" ? { version: r["version"] } : {}),
      })),
    [props.rows],
  );
  const bulk = useBulk(props.bulk, refs);
  const { selection, bar } = bulk;
  const rowMenu = useRowMenu();
  const previews = useMemo(
    () => new Map(props.rows.flatMap((r) => (r.preview ? [[r.id, r.preview] as const] : []))),
    [props.rows],
  );
  const first = props.columns[0]?.key;
  const hover = useHoverCards((id, column) => {
    const preview = column === first ? previews.get(id) : undefined;
    return preview ? { kind: "record", ...preview } : null;
  });
  const activatable = props.activatable !== false;
  return (
    <>
      <div {...hover.hoverProps}>
        <DataTable
          {...(activatable
            ? {
                onRowContextMenu: (
                  row: Record<string, unknown>,
                  _i: number,
                  at: { x: number; y: number } | null,
                  cell: HTMLElement,
                ) => {
                  const id = String(row["id"]);
                  rowMenu.open(
                    {
                      id,
                      label: String(row["label"] ?? id),
                      open: () => router.push(href({ peek: id, full: null })),
                      href: href({ peek: id, full: "1" }),
                      bulk,
                    },
                    at,
                    cell,
                  );
                },
              }
            : {})}
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
      </div>
      {bar}
      {rowMenu.menu}
      {hover.card}
    </>
  );
}
