"use client";

import { DataTable, type DataTableColumn } from "@xos/ui";
import { useFinanceT } from "./kit-use-finance-t";
import { useQueryNav } from "./kit-use-query-nav";
import { type Row } from "./kit.types";

/** The table view: Enter or a double click on a row opens its peek. */
export function CollectionTable({
  label,
  columns,
  rows,
  totals,
}: {
  label: string;
  columns: DataTableColumn[];
  rows: readonly Row[];
  totals?: Record<string, unknown>;
}) {
  const go = useQueryNav();
  const t = useFinanceT();
  return (
    <div className="flex flex-col gap-6">
      <DataTable
        caption={label}
        label={label}
        columns={columns}
        rows={[...rows]}
        {...(totals ? { totals, totalsLabel: t("common.total") } : {})}
        onRowActivate={(row) => go({ peek: String(row["id"]) })}
      />
      <p className="m-0 text-text-11 text-text-secondary">{t("common.tableHint")}</p>
    </div>
  );
}
