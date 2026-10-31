"use client";

import type { AuroraExtraction, AuroraSuggestion, AuroraSuggestionField } from "@xos/ai/client";
import { Button, Checkbox, InlineAlert, Input } from "@xos/ui";
import { useId, useState } from "react";
import { flushSync } from "react-dom";
import {
  AiGenerated,
  AiPanel,
  AvailabilityNotice,
  fillForm,
  LiveRegion,
  OutcomeNotice,
  outcomeAnnouncement,
  outcomeOf,
  SentList,
  useAurora,
  useEntryT,
  type Outcome,
  type Translate,
} from "./shared";
import type { ExtractEntryProps } from "./extract-entry";

const MAX_BYTES = 10 * 1024 * 1024;
const MEDIA = ["application/pdf", "text/plain", "image/png", "image/jpeg", "image/webp"] as const;
type Media = (typeof MEDIA)[number];

/** Each kind's header operation and line operation, as the extraction proposes them. */
const LINE_OPERATION = "rfqResponseLines.create";

interface Line {
  readonly id: string;
  readonly include: boolean;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
}

type Phase =
  | { readonly kind: "compose" }
  | { readonly kind: "sending" }
  | { readonly kind: "failed"; readonly outcome: Outcome<AuroraExtraction> }
  | {
      readonly kind: "review";
      readonly model: string | null;
      readonly header: AuroraSuggestion;
      readonly lines: readonly AuroraSuggestion[];
      /** A receipt's items against its printed total (B15), read-only. */
      readonly tieOut: AuroraExtraction["tie_out"] | null;
    };

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Digits after the decimal point in a currency, 2 when the code is unknown. */
export function currencyExponent(code: string | null | undefined): number {
  if (!code || !/^[A-Z]{3}$/.test(code)) return 2;
  try {
    return (
      new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** Minor units as the major-unit amount a form takes: 12500 in USD is "125.00". */
export function majorUnits(minor: number, code: string | null | undefined): string {
  const exponent = currencyExponent(code);
  return (minor / 10 ** exponent).toFixed(exponent);
}

/** A field's proposed value as text, or "" when it was not read. */
function valueOf(field: AuroraSuggestionField | undefined): string {
  if (!field || field.refusal !== null || field.proposed_value === null) return "";
  return String(field.proposed_value);
}

function fieldOf(s: AuroraSuggestion, path: string): AuroraSuggestionField | undefined {
  return s.proposed_fields.find((f) => f.field_path === path);
}

/**
 * Extraction with Aurora into a form (Section 4.7, A95). Before anything is sent the panel lists
 * exactly what Aurora receives: the one file the person picked and what kind of document it is.
 * The proposal comes back field by field with a confidence and the words each value was read from;
 * a price, date or quantity the document does not show is left empty with the reason (the silence
 * rule). The person corrects any value, then fills the form; discarding rejects every suggestion.
 */
export function ExtractDialog({
  kind,
  fields,
  lines: lineFields,
  ensureRows,
  form,
  filled,
  onFilled,
  open,
  onOpenChange,
}: ExtractEntryProps & {
  form: () => HTMLFormElement | null;
  filled: readonly string[];
  onFilled: (ids: readonly string[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useEntryT();
  const id = useId();
  const { client, availability, check } = useAurora("extraction", open);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "compose" });
  const [values, setValues] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<readonly Line[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const [warning, setWarning] = useState<string | null>(null);

  const reject = async (ids: readonly string[], reason: string) => {
    await Promise.all(ids.map((s) => client.reject(s, reason)));
  };

  const send = async () => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setWarning(t("extract.tooLarge"));
      return;
    }
    setWarning(null);
    const media: Media = (MEDIA as readonly string[]).includes(file.type)
      ? (file.type as Media)
      : "text/plain";
    setPhase({ kind: "sending" });
    setAnnouncement(t("sending"));
    const outcome = outcomeOf<AuroraExtraction>(
      await client.extract({
        kind,
        media_type: media,
        content_base64: await toBase64(file),
        file_name: file.name,
      }),
    );
    if (outcome.kind !== "answer") {
      setPhase({ kind: "failed", outcome });
      setAnnouncement(outcomeAnnouncement(outcome, t, ""));
      return;
    }
    const loaded = await Promise.all(
      outcome.suggestions.map((s) => client.suggestion(s.suggestion_id)),
    );
    const suggestions = loaded.flatMap((r) => (r.ok ? [r.data] : []));
    const header = suggestions.find((s) => s.operation_id !== LINE_OPERATION);
    if (!header || suggestions.length !== loaded.length) {
      setPhase({ kind: "failed", outcome: { kind: "failed" } });
      setAnnouncement(t("problems.failed"));
      return;
    }
    const lineSuggestions = suggestions.filter((s) => s.operation_id === LINE_OPERATION);
    const currency = valueOf(fieldOf(header, "currency_code")) || null;
    setValues(
      Object.fromEntries(
        header.proposed_fields.map((f) => [
          f.field_path,
          fields[f.field_path]?.as === "money" && valueOf(f) !== ""
            ? majorUnits(Number(f.proposed_value), currency)
            : valueOf(f),
        ]),
      ),
    );
    setLines(
      lineSuggestions.map((s) => {
        const price = valueOf(fieldOf(s, "unit_price_minor"));
        const lineCurrency = valueOf(fieldOf(s, "currency_code")) || currency;
        return {
          id: s.id,
          include: valueOf(fieldOf(s, "description")) !== "",
          description: valueOf(fieldOf(s, "description")),
          quantity: valueOf(fieldOf(s, "quantity")),
          unitPrice: price === "" ? "" : majorUnits(Number(price), lineCurrency),
        };
      }),
    );
    setPhase({
      kind: "review",
      model: outcome.model,
      header,
      lines: lineSuggestions,
      tieOut: outcome.answer.tie_out ?? null,
    });
    setAnnouncement(t("extract.ready"));
  };

  const fill = async () => {
    if (phase.kind !== "review") return;
    const target = form();
    if (!target) return;
    const chosen = lines.filter((l) => l.include && l.description.trim() !== "");
    if (lineFields && chosen.length > 0) flushSync(() => ensureRows?.(chosen.length));
    const writes: Record<string, string | readonly string[]> = {};
    for (const [path, spec] of Object.entries(fields)) {
      const value = values[path] ?? "";
      if (value !== "") writes[spec.name] = value;
    }
    if (lineFields && chosen.length > 0) {
      writes[lineFields.description] = chosen.map((l) => l.description);
      writes[lineFields.quantity] = chosen.map((l) => l.quantity);
      writes[lineFields.unitPrice] = chosen.map((l) => l.unitPrice);
    }
    const missing = fillForm(target, writes);
    // Suggestions replaced by this reading, and lines left out, are closed as rejected now.
    const kept = [phase.header.id, ...chosen.map((l) => l.id)];
    const dropped = [
      ...filled.filter((s) => !kept.includes(s)),
      ...lines.filter((l) => !kept.includes(l.id)).map((l) => l.id),
    ];
    await reject(dropped, t("extract.rejectReason"));
    onFilled(kept);
    onOpenChange(false);
    setAnnouncement(
      missing.length > 0
        ? t("extract.filledSome", { fields: missing.join(", ") })
        : t("extract.filled"),
    );
  };

  const discard = async () => {
    if (phase.kind === "review") {
      await reject([phase.header.id, ...phase.lines.map((l) => l.id)], t("extract.discardReason"));
    }
    onOpenChange(false);
    setAnnouncement(t("extract.discarded"));
  };

  const ready = availability.kind === "ready";

  return (
    <>
      <LiveRegion message={announcement} />
      <AiPanel
        title={t(`extract.title.${kind}`)}
        open={open}
        onOpenChange={onOpenChange}
        footer={
          phase.kind === "review" ? (
            <>
              <Button variant="ghost" onClick={() => void discard()}>
                {t("discard")}
              </Button>
              <Button variant="primary" onClick={() => void fill()}>
                {t("extract.fill")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("close")}
              </Button>
              <Button
                variant="primary"
                icon="Sparkles"
                loading={phase.kind === "sending"}
                disabled={!ready || !file || phase.kind === "sending"}
                onClick={() => void send()}
              >
                {t("send")}
              </Button>
            </>
          )
        }
      >
        <AvailabilityNotice availability={availability} onRetry={() => void check()} />
        {phase.kind === "review" && phase.tieOut ? (
          <p className="m-0 text-text-12 text-text-secondary" data-testid="receipt-tie-out">
            {phase.tieOut.status === "ties"
              ? t("intake.tieOut.ties")
              : phase.tieOut.status === "incomplete"
                ? t("intake.tieOut.incomplete")
                : t("intake.tieOut.residual", {
                    amount: majorUnits(
                      phase.tieOut.totalResidualMinor ?? 0,
                      valueOf(fieldOf(phase.header, "currency_code")) || null,
                    ),
                  })}
          </p>
        ) : null}
        {phase.kind === "review" ? (
          <Review
            t={t}
            id={id}
            model={phase.model}
            header={phase.header}
            fields={fields}
            values={values}
            onValue={(path, value) => setValues((v) => ({ ...v, [path]: value }))}
            lines={lineFields ? lines : []}
            onLine={(index, change) =>
              setLines((all) => all.map((l, i) => (i === index ? { ...l, ...change } : l)))
            }
          />
        ) : (
          <div className="flex flex-col gap-12">
            <label className="flex flex-col gap-4 text-text-12">
              <span className="font-medium">{t("extract.file")}</span>
              <input
                type="file"
                accept=".pdf,.txt,.png,.jpg,.jpeg,.webp"
                aria-describedby={`${id}-file-help`}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <span id={`${id}-file-help`} className="text-text-secondary">
                {t("extract.fileHelp")}
              </span>
            </label>
            <SentList
              items={[
                { label: t("extract.sentKind"), value: t(`extract.kind.${kind}`) },
                {
                  label: t("extract.sentFile"),
                  value: file
                    ? t("extract.fileLine", {
                        name: file.name,
                        type: file.type || "text/plain",
                        size: Math.max(1, Math.round(file.size / 1024)),
                      })
                    : t("extract.noFile"),
                },
                { label: t("extract.sentNothingElse"), value: t("extract.nothingElse") },
              ]}
            />
            {warning ? <InlineAlert tone="warning">{warning}</InlineAlert> : null}
            {phase.kind === "sending" ? (
              <p role="status" className="m-0 text-text-13 text-text-secondary">
                {t("extract.reading")}
              </p>
            ) : null}
            {phase.kind === "failed" ? <OutcomeNotice outcome={phase.outcome} /> : null}
          </div>
        )}
      </AiPanel>
    </>
  );
}

function Review({
  t,
  id,
  model,
  header,
  fields,
  values,
  onValue,
  lines,
  onLine,
}: {
  t: Translate;
  id: string;
  model: string | null;
  header: AuroraSuggestion;
  fields: ExtractEntryProps["fields"];
  values: Readonly<Record<string, string>>;
  onValue: (path: string, value: string) => void;
  lines: readonly Line[];
  onLine: (index: number, change: Partial<Line>) => void;
}) {
  return (
    <div className="flex flex-col gap-12">
      <AiGenerated model={model} />
      <p className="m-0 text-text-12 text-text-secondary">{t("extract.review")}</p>
      <span className="text-text-11 text-text-tertiary">{t("extract.provenance")}</span>
      <ul className="m-0 flex list-none flex-col gap-12 p-0" aria-label={t("extract.fieldsLabel")}>
        {header.proposed_fields.map((f) => {
          const written = fields[f.field_path] !== undefined;
          return (
            <li key={f.field_path} className="flex flex-col gap-4">
              <Input
                id={`${id}-${f.field_path}`}
                label={t(`extract.fields.${f.field_path}`)}
                width="100%"
                value={values[f.field_path] ?? ""}
                readOnly={!written}
                onChange={(e) => onValue(f.field_path, e.target.value)}
                help={
                  f.refusal !== null
                    ? t("extract.notRead", { missing: f.missing ?? "" })
                    : [
                        f.confidence !== null
                          ? t("extract.confidence", { percent: Math.round(f.confidence * 100) })
                          : "",
                        f.source_excerpt ? t("extract.source", { excerpt: f.source_excerpt }) : "",
                        written ? "" : t("extract.notWritten"),
                      ]
                        .filter((part) => part !== "")
                        .join(" ")
                }
              />
            </li>
          );
        })}
      </ul>
      {lines.length > 0 ? (
        <section aria-labelledby={`${id}-lines`} className="flex flex-col gap-8">
          <h3 id={`${id}-lines`} className="m-0 text-text-13 font-semibold">
            {t("extract.linesTitle")}
          </h3>
          <ol className="m-0 flex list-none flex-col gap-12 p-0">
            {lines.map((line, i) => (
              <li
                key={line.id}
                className="flex flex-col gap-8 rounded-control border border-border-subtle p-8"
              >
                <Checkbox
                  label={t("extract.includeLine", { n: i + 1 })}
                  checked={line.include}
                  onChange={(e) => onLine(i, { include: e.target.checked })}
                />
                <Input
                  id={`${id}-line-${i}-description`}
                  label={t("extract.lineDescription", { n: i + 1 })}
                  width="100%"
                  value={line.description}
                  onChange={(e) => onLine(i, { description: e.target.value })}
                />
                <div className="flex flex-wrap gap-8">
                  <Input
                    id={`${id}-line-${i}-quantity`}
                    label={t("extract.lineQuantity")}
                    inputMode="decimal"
                    value={line.quantity}
                    onChange={(e) => onLine(i, { quantity: e.target.value })}
                    help={line.quantity === "" ? t("extract.lineNotRead") : ""}
                  />
                  <Input
                    id={`${id}-line-${i}-price`}
                    label={t("extract.lineUnitPrice")}
                    inputMode="decimal"
                    value={line.unitPrice}
                    onChange={(e) => onLine(i, { unitPrice: e.target.value })}
                    help={line.unitPrice === "" ? t("extract.lineNotRead") : ""}
                  />
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
