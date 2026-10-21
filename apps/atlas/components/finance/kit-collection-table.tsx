"use client";

import { DataTable, type DataTableColumn } from "@xos/ui";
import { useMemo } from "react";
import type { BulkConfig } from "@/components/bulk/types";
import { useBulk } from "@/components/bulk/use-bulk";
import { useFinanceT } from "./kit-use-finance-t";
import { useQueryNav } from "./kit-use-query-nav";
import { type Row } from "./kit.types";

/**
 * The table view: Enter or a double click on a row opens its peek. With `bulk`, rows can be
 * selected and changed together (Section 11.7); each row names itself in its `label` field.
 */
export function CollectionTable({
  label,
  columns,
  rows,
  totals,
  bulk,
}: {
  label: string;
  columns: DataTableColumn[];
  rows: readonly Row[];
  totals?: Record<string, unknown>;
  bulk?: BulkConfig | null;
}) {
  const go = useQueryNav();
  const t = useFinanceT();
  const refs = useMemo(
    () => rows.map((r) => ({ id: r.id, label: String(r["label"] ?? r.id) })),
    [rows],
  );
  const { selection, bar } = useBulk(bulk, refs);
  return (
    <div className="flex flex-col gap-6">
      <DataTable
        caption={label}
        label={label}
        columns={columns}
        rows={[...rows]}
        {...(totals ? { totals, totalsLabel: t("common.total") } : {})}
        onRowActivate={(row) => go({ peek: String(row["id"]) })}
        {...(selection ? { selection } : {})}
      />
      <p className="m-0 text-text-11 text-text-secondary">{t("common.tableHint")}</p>
      {bar}
    </div>
  );
}
