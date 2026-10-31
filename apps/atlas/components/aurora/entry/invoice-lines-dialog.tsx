"use client";

import type {
  AuroraExtraction,
  AuroraLineHistory,
  AuroraProblem,
  AuroraSuggestion,
} from "@xos/ai/client";
import { computeTieOut, priceVariance, VARIANCE_BADGE } from "@xos/ai/tieout";
import { Button, Checkbox, InlineAlert, Input, Select, Tag } from "@xos/ui";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";
import type { InvoiceLinesEntryProps } from "./intake-entry";
import { fileSource, formatMinor, MAX_FILE_BYTES, ProblemAlert, textOf } from "./intake-shared";
import {
  AiGenerated,
  AiPanel,
  AvailabilityNotice,
  LiveRegion,
  useAurora,
  useEntryT,
} from "./shared";

interface Row {
  readonly suggestionId: string;
  readonly include: boolean;
  readonly description: string;
  readonly quantity: string;
  /** Unit price in minor units as text, "" when unpriced. */
  readonly unitPrice: string;
  readonly budgetLineId: string;
  readonly taxRateId: string;
  readonly history: readonly AuroraLineHistory[];
  readonly excerpt: string;
}

type Phase =
  | { readonly kind: "pick" }
  | { readonly kind: "reading" }
  | { readonly kind: "review"; readonly model: string | null; readonly answer: AuroraExtraction }
  | { readonly kind: "added"; readonly count: number; readonly stopped: string | null };

const minor = (text: string) =>
  text.trim() === "" || !/^-?\d+$/.test(text.trim()) ? null : Number(text.trim());

/**
 * Read lines from a document (B15, parity gap G-225). Aurora reads a Proposed payable invoice's
 * lines into proposals; the person sets each line's budget line (empty until they choose it, never
 * proposed), sees the vendor's earlier lines as hints with a variance badge, and a tie-out of the
 * lines against the printed totals recomputed on every edit. A residual must be acknowledged, an
 * advisory check only (ADR 0154). "Add lines" confirms the kept lines one by one after the
 * invoice's last line, through aiSuggestions.confirm, stopping at the first refusal.
 */
export function InvoiceLinesDialog({
  invoiceId,
  currencyCode,
  lastLineNumber,
  budgetLines,
  taxRates,
  open,
  onOpenChange,
}: InvoiceLinesEntryProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useEntryT();
  const id = useId();
  const locale = useLocale();
  const router = useRouter();
  const { client, availability, check } = useAurora("extraction", open);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [rows, setRows] = useState<Row[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [problem, setProblem] = useState<AuroraProblem | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const ready = availability.kind === "ready";

  const read = async () => {
    if (!file) return;
    setProblem(null);
    setPhase({ kind: "reading" });
    const result = await client.extract({
      kind: "invoice_lines",
      invoice_id: invoiceId,
      ...(await fileSource(file)),
    });
    if (!result.ok || result.data.answer === null) {
      if (!result.ok) setProblem(result.problem);
      return setPhase({ kind: "pick" });
    }
    const answer = result.data.answer;
    const stored: AuroraSuggestion[] = [];
    for (const s of result.data.suggestions) {
      const read = await client.suggestion(s.suggestion_id);
      if (read.ok) stored.push(read.data);
    }
    setRows(
      stored.map((s, i) => ({
        suggestionId: s.id,
        include: true,
        description: textOf(s, "description"),
        quantity: textOf(s, "quantity"),
        unitPrice: textOf(s, "unit_price_minor"),
        budgetLineId: "",
        taxRateId: "",
        history: (answer.history ?? []).filter((h) => h.description_index === i + 1),
        excerpt: s.proposed_fields.find((f) => f.source_excerpt)?.source_excerpt ?? "",
      })),
    );
    setPhase({ kind: "review", model: result.data.model, answer });
    setAnnouncement(t("intake.invoiceLines.ready"));
  };

  const printed = phase.kind === "review" ? (phase.answer.check ?? {}) : {};
  const num = (path: string) => {
    const v = printed[path]?.value;
    return typeof v === "number" ? v : null;
  };
  const kept = rows.filter((r) => r.include);
  // Recomputed on every edit, with the same rounding as private.extended_minor.
  const tie = useMemo(
    () =>
      computeTieOut({
        lines: kept.map((r) => ({
          quantity: r.quantity.trim() === "" ? null : r.quantity,
          unitPriceMinor: minor(r.unitPrice),
        })),
        printed: {
          subtotal: num("printed_subtotal_minor"),
          tax: num("printed_tax_minor"),
          shipping: num("printed_shipping_minor"),
          total: num("printed_total_minor"),
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- printed changes only with the phase
    [rows, phase],
  );
  const residual = tie.totalResidualMinor !== null && tie.totalResidualMinor !== 0;
  const missingQuantity = kept.some(
    (r) => r.quantity.trim() === "" || Number.isNaN(Number(r.quantity)),
  );
  const currencyFlag =
    phase.kind === "review" && (phase.answer.tie_out?.flags ?? []).includes("currency_mismatch");

  const add = async () => {
    setProblem(null);
    let added = 0;
    let stopped: string | null = null;
    for (const [k, r] of kept.entries()) {
      const result = await client.confirm(r.suggestionId, t("intake.invoiceLines.reason"), {
        invoice_id: invoiceId,
        line_number: lastLineNumber + k + 1,
        description: r.description.trim(),
        quantity: Number(r.quantity),
        unit_price_minor: minor(r.unitPrice),
        ...(r.budgetLineId ? { budget_line_id: r.budgetLineId } : {}),
        ...(r.taxRateId ? { tax_rate_id: r.taxRateId } : {}),
      });
      if (!result.ok) {
        setProblem(result.problem);
        stopped = r.description;
        break;
      }
      added += 1;
    }
    if (stopped === null) {
      for (const r of rows.filter((x) => !x.include))
        await client.reject(r.suggestionId, t("intake.invoiceLines.leftOut"));
    }
    setPhase({ kind: "added", count: added, stopped });
    setAnnouncement(t("intake.invoiceLines.added", { count: added }));
    if (added > 0) router.refresh();
  };

  const set = (i: number, patch: Partial<Row>) =>
    setRows((all) => all.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const money = (value: number | null) =>
    value === null ? t("intake.unread") : formatMinor(value, currencyCode, locale);

  return (
    <>
      <LiveRegion message={announcement} />
      <AiPanel
        title={t("intake.invoiceLines.title")}
        open={open}
        onOpenChange={onOpenChange}
        footer={
          phase.kind === "review" ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("discard")}
              </Button>
              <Button
                variant="primary"
                disabled={kept.length === 0 || missingQuantity || (residual && !acknowledged)}
                onClick={() => void add()}
              >
                {t("intake.invoiceLines.add", { count: kept.length })}
              </Button>
            </>
          ) : phase.kind === "added" ? (
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
                icon="Sparkles"
                loading={phase.kind === "reading"}
                disabled={
                  !ready || !file || (file?.size ?? 0) > MAX_FILE_BYTES || phase.kind === "reading"
                }
                onClick={() => void read()}
              >
                {t("send")}
              </Button>
            </>
          )
        }
      >
        <AvailabilityNotice availability={availability} onRetry={() => void check()} />
        <ProblemAlert t={t} problem={problem} />
        {phase.kind === "pick" || phase.kind === "reading" ? (
          <div className="flex flex-col gap-12">
            <label className="flex flex-col gap-4 text-text-13" htmlFor={`${id}-file`}>
              <span className="font-medium">{t("intake.file")}</span>
              <input
                id={`${id}-file`}
                type="file"
                accept="application/pdf,text/plain,image/png,image/jpeg,image/webp"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <p className="m-0 text-text-12 text-text-secondary">{t("intake.invoiceLines.sent")}</p>
          </div>
        ) : null}
        {phase.kind === "review" ? (
          <div className="flex flex-col gap-12">
            <AiGenerated model={phase.model} />
            <p className="m-0 text-text-12 text-text-secondary">
              {t("intake.invoiceLines.review")}
            </p>
            {currencyFlag ? (
              <InlineAlert tone="warning">
                {t("intake.tieOut.currencyMismatch", { currency: currencyCode })}
              </InlineAlert>
            ) : null}
            <ul
              className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
              aria-label={t("intake.invoiceLines.rows")}
            >
              {rows.map((r, i) => {
                const reference = r.history[0];
                const variance = priceVariance(
                  minor(r.unitPrice),
                  reference?.unit_price_minor ?? null,
                );
                return (
                  <li
                    key={r.suggestionId}
                    className="flex flex-col gap-8 py-8"
                    data-testid="invoice-line-row"
                  >
                    <Checkbox
                      label={r.description || t("intake.unread")}
                      checked={r.include}
                      onChange={(e) => set(i, { include: e.currentTarget.checked })}
                    />
                    <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
                      <Input
                        label={t("intake.invoiceLines.description")}
                        value={r.description}
                        onChange={(e) => set(i, { description: e.target.value })}
                      />
                      <Input
                        label={t("intake.invoiceLines.quantity")}
                        inputMode="decimal"
                        value={r.quantity}
                        error={
                          r.include && r.quantity.trim() === ""
                            ? t("intake.invoiceLines.quantityRequired")
                            : ""
                        }
                        onChange={(e) => set(i, { quantity: e.target.value })}
                      />
                      <Input
                        label={t("intake.invoiceLines.unitPrice", { currency: currencyCode })}
                        inputMode="numeric"
                        help={t("intake.invoiceLines.unitPriceHelp")}
                        value={r.unitPrice}
                        onChange={(e) => set(i, { unitPrice: e.target.value })}
                      />
                      <Select
                        label={t("intake.invoiceLines.budgetLine")}
                        value={r.budgetLineId}
                        options={[
                          { value: "", label: t("intake.invoiceLines.noBudgetLine") },
                          ...budgetLines,
                        ]}
                        onChange={(e) => set(i, { budgetLineId: e.target.value })}
                      />
                      {taxRates.length > 0 ? (
                        <Select
                          label={t("intake.invoiceLines.taxRate")}
                          value={r.taxRateId}
                          options={[
                            { value: "", label: t("intake.invoiceLines.noTaxRate") },
                            ...taxRates,
                          ]}
                          onChange={(e) => set(i, { taxRateId: e.target.value })}
                        />
                      ) : null}
                    </div>
                    {r.history.map((h) => (
                      <p
                        key={`${h.source}-${h.reference}-${h.line_number}`}
                        className="m-0 text-text-12 text-text-secondary"
                      >
                        {h.source === "invoice"
                          ? t("intake.invoiceLines.historyInvoice", {
                              price: money(h.unit_price_minor),
                              reference: h.reference ?? "",
                              date: h.issued_on ?? "",
                            })
                          : t("intake.invoiceLines.historyOrder", {
                              reference: h.reference ?? "",
                              line: h.line_number,
                              quantity: h.quantity,
                              price: money(h.unit_price_minor),
                            })}
                      </p>
                    ))}
                    {variance !== null && variance >= VARIANCE_BADGE ? (
                      <Tag tone="warning">
                        {t("intake.invoiceLines.variance", { percent: Math.round(variance * 100) })}
                      </Tag>
                    ) : null}
                    {r.excerpt ? (
                      <p className="m-0 text-text-12 text-text-secondary">
                        {t("intake.excerpt", { excerpt: r.excerpt })}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <div
              className="flex flex-col gap-4 rounded-8 border border-border-subtle p-12"
              data-testid="tie-out"
              role="group"
              aria-label={t("intake.tieOut.title")}
            >
              <span className="text-text-13 font-medium">{t("intake.tieOut.title")}</span>
              <span className="text-text-13">
                {t("intake.tieOut.lines", { amount: money(tie.linesMinor) })}
              </span>
              <span className="text-text-13">
                {t("intake.tieOut.printed", { amount: money(num("printed_total_minor")) })}
              </span>
              <span className="text-text-13" data-testid="tie-out-status">
                {tie.status === "ties"
                  ? t("intake.tieOut.ties")
                  : tie.status === "incomplete"
                    ? t("intake.tieOut.incomplete")
                    : t("intake.tieOut.residual", { amount: money(tie.totalResidualMinor) })}
              </span>
              {residual ? (
                <Checkbox
                  label={t("intake.tieOut.acknowledge")}
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.currentTarget.checked)}
                />
              ) : null}
            </div>
          </div>
        ) : null}
        {phase.kind === "added" ? (
          <InlineAlert tone={phase.stopped ? "warning" : "success"}>
            {phase.stopped
              ? t("intake.invoiceLines.stopped", { count: phase.count, line: phase.stopped })
              : t("intake.invoiceLines.added", { count: phase.count })}
          </InlineAlert>
        ) : null}
      </AiPanel>
    </>
  );
}
