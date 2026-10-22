import { csvField } from "../csv.ts";
import { documentTranslator, formatter, type Formatter, type Translate } from "./format.ts";
import type { ComplianceDocumentKind, DocumentBlock, DocumentModel } from "./model.ts";

/**
 * The scaffold shared by the compliance forms (Section 14.5, ADR 0041): the WH-347 certified payroll
 * and OSHA Forms 300, 300A and 301 are not record documents, so each builds its blocks from its own
 * loader and wraps them here in the ADR 0031 model: the facts block, the translated labels and the
 * Section 8.6 watermark every one of them carries.
 */

export interface ComplianceModelInput {
  readonly kind: ComplianceDocumentKind;
  readonly locale: string;
  /** The `documents` namespace of the caller's catalog. */
  readonly messages: unknown;
  readonly title: string;
  /** What the facts block names the form by, for example "OSHA 300 2026". */
  readonly recordKey: string;
  readonly recordUrl: string;
  readonly brand: DocumentModel["brand"];
  readonly blocks: readonly DocumentBlock[];
  readonly watermark: string;
  readonly now?: Date;
  readonly timeZone?: string;
}

export function complianceTools(
  messages: unknown,
  locale: string,
  timeZone = "UTC",
): { t: Translate; f: Formatter } {
  const t = documentTranslator(messages);
  return { t, f: formatter(locale, timeZone, t) };
}

export function complianceModel(input: ComplianceModelInput): DocumentModel {
  const { t, f } = complianceTools(input.messages, input.locale, input.timeZone);
  const now = input.now ?? new Date();
  return {
    kind: input.kind,
    lang: input.locale,
    title: input.title,
    brand: input.brand,
    facts: {
      recordKey: input.recordKey,
      templateVersion: 1,
      generatedAt: f.dateTime(now.toISOString()),
      generatedAtIso: now.toISOString(),
      recordUrl: input.recordUrl,
      labels: {
        recordKey: t("compliance.form"),
        version: t("facts.version"),
        generatedAt: t("facts.generatedAt"),
        qrAlt: t("compliance.qrAlt", { form: input.recordKey }),
        page: (page, total) => t("facts.page", { page, total }),
      },
    },
    blocks: input.blocks,
    watermark: { text: input.watermark },
  };
}

/** A CSV file: one header row and the rows, every field through csvField (A69-005), CRLF lines. */
export function toCsvFile(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [header, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}
