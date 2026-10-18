import { type ReactElement } from "react";
import type { GridColumn } from "../types/reference";
import { useT } from "../lib/context.tsx";
import { InlineAlert } from "../Feedback/Feedback.tsx";
import { type BidSheetProps } from "./Grids.types.ts";
import { SpreadsheetGrid } from "./SpreadsheetGrid.tsx";

/** A sealed line-item bid: unit prices are the only editable cells; extended amounts and the total are derived and stay Unpriced while any line is blank. */
export function BidSheet({ deadline, lines, onChange }: BidSheetProps): ReactElement {
  const t = useT();
  const columns: GridColumn[] = [
    { key: "line", label: t("bid.line"), type: "code", width: 64 },
    { key: "item", label: t("bid.item") },
    { key: "unit", label: t("bid.unit"), width: 72 },
    { key: "qty", label: t("bid.qty"), type: "number", width: 64 },
    { key: "price", label: t("bid.unitPrice"), type: "money", editable: true },
    {
      key: "ext",
      label: t("bid.extended"),
      type: "money",
      total: true,
      derive: (row) =>
        typeof row["qty"] === "number" && typeof row["price"] === "number"
          ? row["qty"] * row["price"]
          : null,
    },
  ];
  return (
    <div className="flex flex-col gap-12">
      <InlineAlert tone="info" title={t("bid.sealed")}>
        {t("bid.sealedBody", { deadline })}
      </InlineAlert>
      <SpreadsheetGrid
        label={t("bid.lines")}
        columns={columns}
        rows={lines.map((l) => ({
          line: l.line,
          item: l.item,
          unit: l.unit,
          qty: l.qty,
          price: l.price,
          ext: l.ext,
        }))}
        totalsLabel={t("bid.total")}
        onChange={(rows) =>
          onChange?.(
            rows.map((r) => ({
              line: String(r["line"] ?? ""),
              item: String(r["item"] ?? ""),
              unit: String(r["unit"] ?? ""),
              qty: Number(r["qty"] ?? 0),
              price: typeof r["price"] === "number" ? r["price"] : null,
              ext:
                typeof r["qty"] === "number" && typeof r["price"] === "number"
                  ? r["qty"] * r["price"]
                  : null,
            })),
          )
        }
      />
    </div>
  );
}
