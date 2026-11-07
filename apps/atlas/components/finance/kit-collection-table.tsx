"use client";

import { DataTable, type DataTableColumn } from "@xos/ui";
import { useMemo } from "react";
import type { BulkConfig } from "@/components/bulk/types";
import { useCustomFieldColumns } from "@/components/custom-fields/list";
import { useFinanceT } from "./kit-use-finance-t";
import { useItemActions } from "./kit-use-item-actions";
import { useQueryNav } from "./kit-use-query-nav";
import { type ListItem, type Row } from "./kit.types";

/**
 * The table view: Enter or a double click on a row opens its peek. With `bulk`, rows can be
 * selected and changed together (Section 11.7); each row names itself in its `label` field. The
 * first column (the row's number or key) previews the row with its list item after 400 ms. On a
 * page with no record panel (`activatable={false}`) rows open nothing: no `?peek`, no Open or Open
 * full page in the row menu, and no hint that Enter opens one. Rows whose record has a peek but no
 * full page (`fullPage={false}`, saved reports) offer Open without Open full page.
 */
export function CollectionTable({
  label,
  columns,
  rows,
  totals,
  bulk,
  previews,
  activatable = true,
  fullPage = true,
}: {
  label: string;
  columns: DataTableColumn[];
  rows: readonly Row[];
  totals?: Record<string, unknown>;
  bulk?: BulkConfig | null;
  /** The rows as list items, for the hover card on the first column. */
  previews?: readonly ListItem[];
  /** False on a page with no record panel for its rows, such as the chart of accounts. */
  activatable?: boolean;
  /** False where the record panel is a peek with no full page (`&full=1`), such as saved reports. */
  fullPage?: boolean;
}) {
  const go = useQueryNav();
  const t = useFinanceT();
  const refs = useMemo(
    () =>
      rows.map((r) => ({
        id: r.id,
        label: String(r["label"] ?? r.id),
        // The version the row was read at, which a bulk change is sent against (Section 11.7).
        ...(typeof r["version"] === "string" ? { version: r["version"] } : {}),
      })),
    [rows],
  );
  const first = columns[0]?.key;
  const items = useItemActions({
    refs,
    previews,
    columns: first ? [first] : [],
    bulk,
    activatable,
    fullPage,
  });
  const { selection } = items.bulk;
  // The list's filterable custom fields (A117), when the page wraps it in a CustomFieldList.
  const custom = useCustomFieldColumns();
  return (
    <div className="flex flex-col gap-6" {...items.hoverProps}>
      <DataTable
        caption={label}
        label={label}
        columns={[...columns, ...custom.columns]}
        rows={rows.map((r) => ({ ...r, ...custom.cells(r.id) }))}
        {...(totals ? { totals, totalsLabel: t("common.total") } : {})}
        {...(activatable ? { onRowActivate: (row) => go({ peek: String(row["id"]) }) } : {})}
        {...(activatable || selection
          ? {
              onRowContextMenu: (row, _index, at, cell) =>
                items.menuFor(String(row["id"]), at, cell),
            }
          : {})}
        {...(selection ? { selection } : {})}
      />
      {activatable ? (
        <p className="m-0 text-text-11 text-text-secondary">{t("common.tableHint")}</p>
      ) : null}
      {items.after}
    </div>
  );
}
