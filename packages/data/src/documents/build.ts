import { documentTranslator, formatter } from "./format.ts";
import type { DocumentKind, DocumentModel, PrintSize } from "./model.ts";
import {
  DESCRIBE,
  TEMPLATES,
  templateFor,
  type DocumentDataMap,
  type TemplateRegistry,
} from "./templates.ts";

/**
 * The pure half of the document pipeline (ADR 0031): record data to the document model, with the template version in
 * force when the record was issued, in the reader's language. It reads nothing, so the guest-email Edge Function
 * (B8) builds a guest pass with it without loading the record loaders that generate.ts brings.
 */

export type DocumentBrand = DocumentModel["brand"];

export interface BuildOptions {
  readonly locale: string;
  /** The `documents` namespace of the caller's catalog. */
  readonly messages: unknown;
  readonly brand: DocumentBrand;
  readonly recordUrl: string;
  readonly now?: Date;
  /** Defaults to the shipped templates; tests pass their own versions. */
  readonly registry?: TemplateRegistry;
  /** The Section 8.6 watermark text for a Confidential or Restricted copy (see watermarkText). */
  readonly watermark?: string;
  /** The size it prints on, which chooses the template version (templateFor); Letter when not given. */
  readonly paper?: PrintSize;
}

/** The model of one document from loaded record data. Pure, so tests and the veraPDF check use it. */
export function buildDocumentModel<K extends DocumentKind>(
  kind: K,
  data: DocumentDataMap[K],
  options: BuildOptions,
): DocumentModel {
  const now = options.now ?? new Date();
  const t = documentTranslator(options.messages);
  const { recordKey, issuedAt } = DESCRIBE[kind](data, now);
  const timeZone = "project" in data && data.project ? data.project.timeZone : "UTC";
  const f = formatter(options.locale, timeZone, t);
  const paper = options.paper ?? "letter";
  const template = templateFor((options.registry ?? TEMPLATES)[kind], issuedAt, paper);
  const out = template.build(data, { t, f, generatedAt: now, paper });
  return {
    kind,
    lang: options.locale,
    title: out.title,
    brand: options.brand,
    facts: {
      recordKey,
      templateVersion: template.version,
      generatedAt: f.dateTime(now.toISOString()),
      generatedAtIso: now.toISOString(),
      recordUrl: options.recordUrl,
      labels: {
        recordKey: t("facts.recordKey"),
        version: t("facts.version"),
        generatedAt: t("facts.generatedAt"),
        qrAlt: t("facts.qrAlt", { key: recordKey }),
        page: (page, total) => t("facts.page", { page, total }),
      },
    },
    blocks: out.blocks,
    ...(options.watermark ? { watermark: { text: options.watermark } } : {}),
  };
}
