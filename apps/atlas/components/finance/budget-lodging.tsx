"use client";

import type { BudgetLineLodging } from "@xos/data/lodging";
import { Button } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { budgetLodgingAction } from "./budget-lodging-actions";

/**
 * Lodging held and assigned on the budget's linked lines (B5, G-67), loaded on request beside the editor: room nights
 * and amounts of the accommodation blocks drawing on each line, derived and never written to it. Lines whose figures
 * are withheld (no hospitality.fulfillment.read) show nothing.
 */
export function BudgetLodging({
  org,
  budgetId,
  lines,
  exponent,
}: {
  org: string;
  budgetId: string;
  lines: readonly {
    readonly id: string;
    readonly lineNumber: number;
    readonly description: string;
  }[];
  exponent: number;
}) {
  const t = useTranslations("finance.budgets.lodging");
  const format = useFormatter();
  const [rows, setRows] = useState<readonly BudgetLineLodging[] | null | "failed">(null);
  const [pending, start] = useTransition();
  if (rows === null || rows === "failed") {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            aria-busy={pending}
            onClick={() =>
              start(async () => setRows((await budgetLodgingAction(org, budgetId)) ?? "failed"))
            }
          >
            {t("load")}
          </Button>
        </div>
        {rows === "failed" ? (
          <p className="m-0 text-text-12 text-text-secondary">{t("failed")}</p>
        ) : null}
      </div>
    );
  }
  const shown = rows.filter(
    (r) => !r.withheld && (r.blockCount ?? 0) + (r.otherCurrencyBlockCount ?? 0) > 0,
  );
  if (shown.length === 0)
    return <p className="m-0 text-text-13 text-text-secondary">{t("empty")}</p>;
  const byId = new Map(lines.map((l) => [l.id, l]));
  const money = (minor: number | null, currency: string) =>
    minor === null
      ? t("unpriced")
      : format.number(minor / 10 ** exponent, { style: "currency", currency });
  return (
    <section aria-label={t("title")} className="flex flex-col gap-4">
      <h3 className="m-0 text-label-14 font-semibold">{t("title")}</h3>
      <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
        {shown.map((r) => {
          const line = byId.get(r.budgetLineId);
          return (
            <li key={r.budgetLineId}>
              <span className="tabular-nums text-text-secondary">{line?.lineNumber ?? ""}</span>{" "}
              {line?.description ?? ""}:{" "}
              {t("lodgingHeld", {
                amount: money(r.heldMinor, r.currencyCode),
                nights: r.heldRoomNights ?? 0,
              })}{" "}
              ·{" "}
              {t("lodgingAssigned", {
                amount: money(r.assignedMinor, r.currencyCode),
                nights: r.assignedRoomNights ?? 0,
              })}
              {(r.otherCurrencyBlockCount ?? 0) > 0
                ? ` · ${t("otherCurrency", { count: r.otherCurrencyBlockCount ?? 0 })}`
                : ""}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
