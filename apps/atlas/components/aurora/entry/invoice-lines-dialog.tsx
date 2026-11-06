"use client";

import type { AuroraLineHistory, AuroraOpenProposal, AuroraProblem } from "@xos/ai/client";
import { tieOut } from "@xos/ai/intake";
import { Button, Checkbox, InlineAlert, Input, Select } from "@xos/ui";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import type { InvoiceLinesEntryProps } from "./intake-entry";
import {
  fieldOf,
  formatMinor,
  minorOf,
  ProblemAlert,
  textOf,
  toMajorText,
  toMinor,
} from "./intake-shared";
import { AiGenerated, AiPanel, LiveRegion, useEntryT, useAurora } from "./shared";

interface Row {
  readonly id: string;
  readonly keep: boolean;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly budgetLineId: string;
  readonly excerpt: string;
}

/**
 * Review Lines from the Document (B15, parity gap G-225). The asker's open line suggestions of this
 * invoice, with the live tie-out recalculated on every edit and each vendor's last billed line as a
 * hint. A budget line is never preselected: "Use This Budget Line" fills the select only on a click.
 * With a nonzero residual, adding needs "I checked the difference". The residual never blocks the
 * invoice afterward; it is a warning.
 */
export function InvoiceLinesDialog({
  invoiceId,
  currencyCode,
  printedTotalMinor,
  existingLines,
  budgetLines,
  open,
  onOpenChange,
}: InvoiceLinesEntryProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useEntryT();
  const id = useId();
  const locale = useLocale();
  const router = useRouter();
  const { client } = useAurora("extraction", open);
  const [rows, setRows] = useState<Row[]>([]);
  const [history, setHistory] = useState<readonly AuroraLineHistory[]>([]);
  const [checked, setChecked] = useState(false);
  const [problem, setProblem] = useState<AuroraProblem | null>(null);
  const [added, setAdded] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (!open) return;
    let live = true;
    void client.invoiceLineProposals(invoiceId).then(async (r) => {
      if (!live) return;
      if (!r.ok) return setProblem(r.problem);
      const proposals: readonly AuroraOpenProposal[] = r.data.data;
      setRows(
        proposals.map((p) => ({
          id: p.id,
          keep: true,
          description: textOf(p, "description"),
          quantity: textOf(p, "quantity"),
          unitPrice: toMajorText(minorOf(p, "unit_price_minor"), currencyCode),
          budgetLineId: "",
          excerpt: fieldOf(p, "unit_price_minor")?.source_excerpt ?? "",
        })),
      );
      const descriptions = proposals.map((p) => textOf(p, "description")).filter((d) => d !== "");
      if (descriptions.length === 0) return;
      const past = await client.lineHistory(invoiceId, descriptions.slice(0, 50));
      if (live && past.ok) setHistory(past.data.data);
    });
    return () => {
      live = false;
    };
  }, [open, client, invoiceId, currencyCode]);

  const set = (rowId: string, patch: Partial<Row>) =>
    setRows((current) => current.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));

  const kept = rows.filter((r) => r.keep);
  // The panel's tie-out equals app.invoice_tie_out after saving: the invoice's own lines plus the kept
  // ones, with printed tax already a line of its own.
  const result = useMemo(
    () =>
      tieOut({
        lines: [
          ...existingLines,
          ...kept.map((r) => ({
            quantity: r.quantity === "" ? 1 : r.quantity,
            unitPriceMinor: r.unitPrice === "" ? null : toMinor(r.unitPrice, currencyCode),
          })),
        ],
        printedTotalMinor,
      }),
    [existingLines, kept, printedTotalMinor, currencyCode],
  );
  const money = (minor: number | null) => formatMinor(minor, currencyCode, locale);
  const needsCheck = result.status === "residual";
  const historyOf = (row: Row) => {
    const position = rows.filter((r) => r.description !== "").findIndex((r) => r.id === row.id) + 1;
    return history.filter((h) => h.description_index === position);
  };

  const add = async () => {
    setProblem(null);
    const applied = await client.applyInvoiceLines({
      invoice_id: invoiceId,
      items: kept.map((r) => ({
        suggestion_id: r.id,
        values: {
          description: r.description,
          quantity: r.quantity === "" ? 1 : Number(r.quantity),
          unit_price_minor: r.unitPrice === "" ? null : toMinor(r.unitPrice, currencyCode),
          ...(r.budgetLineId ? { budget_line_id: r.budgetLineId } : {}),
        },
      })),
    });
    if (!applied.ok) return setProblem(applied.problem);
    setAdded(applied.data.written.length);
    setAnnouncement(t("intake.invoiceLines.added", { count: applied.data.written.length }));
    router.refresh();
  };

  return (
    <>
      <LiveRegion message={announcement} />
      <AiPanel
        title={t("intake.invoiceLines.title")}
        open={open}
        onOpenChange={onOpenChange}
        footer={
          added !== null ? (
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              {t("close")}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("close")}
              </Button>
              <Button
                variant="primary"
                disabled={kept.length === 0 || (needsCheck && !checked)}
                onClick={() => void add()}
              >
                {t("intake.invoiceLines.add")}
              </Button>
            </>
          )
        }
      >
        <ProblemAlert t={t} problem={problem} />
        {added !== null ? (
          <InlineAlert tone="success">
            {t("intake.invoiceLines.added", { count: added })}
          </InlineAlert>
        ) : (
          <div className="flex flex-col gap-12">
            <AiGenerated model={null} />
            <p
              className="m-0 text-text-13"
              data-testid="invoice-tie-out"
              role="status"
              aria-live="polite"
            >
              {result.status === "not_checkable"
                ? t("intake.invoiceLines.notCheckable")
                : t("intake.invoiceLines.tieOut", {
                    printed: money(result.printedTotalMinor),
                    computed: money(result.computedTotalMinor),
                    residual: money(result.residualMinor),
                  })}
            </p>
            {needsCheck ? (
              <Checkbox
                label={t("intake.invoiceLines.checked")}
                checked={checked}
                onChange={(e) => setChecked(e.currentTarget.checked)}
              />
            ) : null}
            <ul
              className="m-0 flex list-none flex-col gap-12 p-0"
              aria-label={t("intake.invoiceLines.lines")}
            >
              {rows.map((r, i) => (
                <li
                  key={r.id}
                  data-testid="invoice-line-row"
                  className="flex flex-col gap-8 rounded-control border border-border-subtle p-8"
                >
                  <Checkbox
                    label={t("intake.keepLine", { name: r.description || String(i + 1) })}
                    checked={r.keep}
                    onChange={(e) => set(r.id, { keep: e.currentTarget.checked })}
                  />
                  <Input
                    id={`${id}-d-${r.id}`}
                    label={t("extract.lineDescription", { n: i + 1 })}
                    width="100%"
                    value={r.description}
                    onChange={(e) => set(r.id, { description: e.target.value })}
                  />
                  <div className="flex flex-wrap gap-8">
                    <Input
                      id={`${id}-q-${r.id}`}
                      label={t("extract.lineQuantity")}
                      inputMode="decimal"
                      value={r.quantity}
                      onChange={(e) => set(r.id, { quantity: e.target.value })}
                    />
                    <Input
                      id={`${id}-p-${r.id}`}
                      label={t("extract.lineUnitPrice")}
                      inputMode="decimal"
                      value={r.unitPrice}
                      onChange={(e) => set(r.id, { unitPrice: e.target.value })}
                    />
                    <Select
                      id={`${id}-b-${r.id}`}
                      label={t("intake.invoiceLines.budgetLine")}
                      value={r.budgetLineId}
                      options={[{ value: "", label: t("intake.choose") }, ...budgetLines]}
                      onChange={(e) => set(r.id, { budgetLineId: e.target.value })}
                    />
                  </div>
                  {r.excerpt ? (
                    <p className="m-0 text-text-12 text-text-secondary">
                      {t("extract.source", { excerpt: r.excerpt })}
                    </p>
                  ) : null}
                  {historyOf(r).map((h, n) => (
                    <div
                      key={n}
                      className="flex flex-wrap items-center gap-8 text-text-12 text-text-secondary"
                      data-testid="vendor-history"
                    >
                      <span>
                        {h.budget_line_name
                          ? t("intake.invoiceLines.lastBilledCoded", {
                              price: formatMinor(h.unit_price_minor, h.currency_code, locale),
                              invoice: h.invoice_number ?? "",
                              line: h.budget_line_name,
                            })
                          : t("intake.invoiceLines.lastBilled", {
                              price: formatMinor(h.unit_price_minor, h.currency_code, locale),
                              invoice: h.invoice_number ?? "",
                            })}
                      </span>
                      {h.budget_line_id ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => set(r.id, { budgetLineId: h.budget_line_id ?? "" })}
                        >
                          {t("intake.invoiceLines.useBudgetLine")}
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        )}
      </AiPanel>
    </>
  );
}
