"use client";

import { DataTable, type DataTableColumn } from "@xos/ui";
import { usePathname, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import type { BulkConfig } from "@/components/bulk/types";
import { useBulk } from "@/components/bulk/use-bulk";
import { useRowMenu } from "@/components/menus/use-row-menu";
import { useFinanceT } from "./kit-use-finance-t";
import { useQueryNav } from "./kit-use-query-nav";
import { type Row } from "./kit.types";

/**
 * The table view: Enter or a double click on a row opens its peek. With `bulk`, rows can be
 * selected and changed together (Section 11.7); each row names itself in its `label` field. On a
 * page with no record panel (`activatable={false}`) rows open nothing: no `?peek`, no Open or Open
 * full page in the row menu, and no hint that Enter opens one.
 */
export function CollectionTable({
  label,
  columns,
  rows,
  totals,
  bulk,
  activatable = true,
}: {
  label: string;
  columns: DataTableColumn[];
  rows: readonly Row[];
  totals?: Record<string, unknown>;
  bulk?: BulkConfig | null;
  /** False on a page with no record panel for its rows, such as the chart of accounts. */
  activatable?: boolean;
}) {
  const go = useQueryNav();
  const t = useFinanceT();
  const refs = useMemo(
    () => rows.map((r) => ({ id: r.id, label: String(r["label"] ?? r.id) })),
    [rows],
  );
  const bulkKit = useBulk(bulk, refs);
  const { selection, bar } = bulkKit;
  const rowMenu = useRowMenu();
  const pathname = usePathname();
  const search = useSearchParams();
  const fullHref = (id: string) => {
    const q = new URLSearchParams(search.toString());
    q.set("peek", id);
    q.set("full", "1");
    return `${pathname}?${q.toString()}`;
  };
  return (
    <div className="flex flex-col gap-6">
      <DataTable
        caption={label}
        label={label}
        columns={columns}
        rows={[...rows]}
        {...(totals ? { totals, totalsLabel: t("common.total") } : {})}
        {...(activatable ? { onRowActivate: (row) => go({ peek: String(row["id"]) }) } : {})}
        {...(activatable || selection
          ? {
              onRowContextMenu: (row, _index, at, cell) => {
                const id = String(row["id"]);
                rowMenu.open(
                  {
                    id,
                    label: String(row["label"] ?? id),
                    ...(activatable ? { open: () => go({ peek: id }), href: fullHref(id) } : {}),
                    bulk: bulkKit,
                  },
                  at,
                  cell,
                );
              },
            }
          : {})}
        {...(selection ? { selection } : {})}
      />
      {activatable ? (
        <p className="m-0 text-text-11 text-text-secondary">{t("common.tableHint")}</p>
      ) : null}
      {bar}
      {rowMenu.menu}
    </div>
  );
}
