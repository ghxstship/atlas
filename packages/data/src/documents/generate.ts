import type { XosClient } from "../client.ts";
import { fail, ok, type Result } from "../result.ts";
import { getOrgBrand } from "../settings.ts";
import { documentTranslator, formatter } from "./format.ts";
import type { DocumentKind, DocumentLogo, DocumentModel, Paper } from "./model.ts";
import type { Orientation } from "./render.ts";
import { isEmbeddableImage, renderDocumentPdf } from "./render.ts";
import { loadDocumentData } from "./sources.ts";
import { loadExternalDocumentData, type ExternalDocumentKind } from "./sources-external.ts";
import {
  DESCRIBE,
  TEMPLATES,
  templateFor,
  type DocumentDataMap,
  type TemplateRegistry,
} from "./templates.ts";

/**
 * The document pipeline (Section 11.9, ADR 0031): load the record as the caller, pick the template
 * version in force when the record was issued, build the model in the caller's language, and render
 * tagged PDF/UA-1. Server only.
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
}

/**
 * The Section 8.6 watermark line: who received the copy and when, in the reader's language and the
 * given time zone (UTC when the viewer's zone is unknown), for example
 * "Downloaded by ana@example.com on Oct 20, 2026, 2:05 PM UTC".
 */
export function watermarkText(
  messages: unknown,
  locale: string,
  email: string,
  at: Date,
  timeZone = "UTC",
): string {
  const t = documentTranslator(messages);
  const f = formatter(locale, timeZone, t);
  return t("facts.watermark", { email, time: f.dateTime(at.toISOString()) });
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
  const template = templateFor((options.registry ?? TEMPLATES)[kind], issuedAt);
  const out = template.build(data, { t, f, generatedAt: now });
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

export interface SharedImageInput {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly orgName: string;
  readonly locale: string;
  /** The `documents` namespace of the caller's catalog. */
  readonly messages: unknown;
  /** The page the copy was opened from; the QR code opens it again. */
  readonly sourceUrl: string;
  readonly watermark: string;
  readonly paper?: Paper;
  readonly now?: Date;
}

/** A download file name: the original name without its extension, letters, digits, dots and dashes. */
export function watermarkedFileName(filename: string): string {
  const base = filename.replace(/[.][A-Za-z0-9]+$/, "").replace(/[^A-Za-z0-9.-]+/g, "-");
  return `${base.replace(/^-+|-+$/g, "") || "shared-image"}-watermarked.pdf`;
}

/**
 * A Confidential or Restricted image delivered with the Section 8.6 watermark: the image in a tagged
 * PDF/UA-1 page (ADR 0031) that carries the viewer email and time, so the unmarked file never leaves.
 */
export function sharedImageModel(input: SharedImageInput): DocumentModel {
  const t = documentTranslator(input.messages);
  const now = input.now ?? new Date();
  const f = formatter(input.locale, "UTC", t);
  return {
    kind: "shared-image",
    lang: input.locale,
    title: t("sharedImage.title", { name: input.filename }),
    brand: { name: input.orgName, legalEntity: null, accentHex: null, logo: null },
    facts: {
      recordKey: input.filename,
      templateVersion: 1,
      generatedAt: f.dateTime(now.toISOString()),
      generatedAtIso: now.toISOString(),
      recordUrl: input.sourceUrl,
      labels: {
        recordKey: t("sharedImage.file"),
        version: t("facts.version"),
        generatedAt: t("facts.generatedAt"),
        qrAlt: t("sharedImage.qrAlt"),
        page: (page, total) => t("facts.page", { page, total }),
      },
    },
    blocks: [
      {
        kind: "image",
        bytes: input.bytes,
        alt: t("sharedImage.alt", { name: input.filename, org: input.orgName }),
      },
    ],
    watermark: { text: input.watermark },
  };
}

export async function renderSharedImagePdf(input: SharedImageInput): Promise<GeneratedDocument> {
  const bytes = await renderDocumentPdf(sharedImageModel(input), {
    paper: input.paper ?? "letter",
  });
  return { bytes, fileName: watermarkedFileName(input.filename), templateVersion: 1 };
}

/** The org's brand for documents: display name, legal entity, accent and a PNG or JPEG logo. */
export async function loadDocumentBrand(
  db: XosClient,
  orgId: string,
  fallbackName: string,
  logoAlt: (name: string) => string,
): Promise<DocumentBrand> {
  const brand = await getOrgBrand(db, orgId);
  const saved = brand.ok ? brand.data : null;
  const name = saved?.displayName?.trim() || fallbackName;
  let logo: DocumentLogo | null = null;
  if (saved?.logoLightPath) {
    const { data } = await db.storage.from("org-brand").download(saved.logoLightPath);
    if (data) {
      const bytes = new Uint8Array(await data.arrayBuffer());
      if (isEmbeddableImage(bytes)) logo = { bytes, alt: logoAlt(name) };
    }
  }
  return {
    name,
    legalEntity: saved?.legalEntityName?.trim() || null,
    accentHex: saved?.accentHex ?? null,
    logo,
  };
}

export interface GenerateInput {
  readonly db: XosClient;
  readonly orgId: string;
  readonly orgName: string;
  readonly kind: DocumentKind;
  readonly id: string;
  readonly locale: string;
  readonly messages: unknown;
  readonly paper: Paper;
  /** The link the QR code opens: the record in the shell that serves the document. */
  readonly recordUrl: (record: {
    readonly recordKey: string;
    readonly projectKey: string | null;
  }) => string;
  readonly now?: Date;
  /** The Section 8.6 watermark text, set for Confidential and Restricted documents. */
  readonly watermark?: string;
  readonly orientation?: Orientation;
}

export interface GeneratedDocument {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly templateVersion: number;
}

/** File names keep letters, digits, dots and dashes. */
export function documentFileName(kind: DocumentKind, recordKey: string, paper: Paper): string {
  const key = recordKey.replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${kind}-${key || "document"}-${paper}.pdf`;
}

export async function generateDocument(input: GenerateInput): Promise<Result<GeneratedDocument>> {
  const data = await loadDocumentData(input.db, input.orgId, input.kind, input.id);
  if (!data.ok) return data;
  return renderLoaded(input, input.kind, data.data, input.orgId, input.orgName);
}

export type ExternalGenerateInput = Omit<GenerateInput, "orgId" | "orgName" | "kind"> & {
  readonly kind: ExternalDocumentKind;
};

/** A document for Gateway, read through the api_external views (sources-external.ts). */
export async function generateExternalDocument(
  input: ExternalGenerateInput,
): Promise<Result<GeneratedDocument>> {
  const loaded = await loadExternalDocumentData(input.db, input.kind, input.id);
  if (!loaded.ok) return loaded;
  return renderLoaded(input, input.kind, loaded.data.data, loaded.data.orgId, loaded.data.orgName);
}

async function renderLoaded<K extends DocumentKind>(
  input: Omit<GenerateInput, "orgId" | "orgName" | "kind">,
  kind: K,
  data: DocumentDataMap[K],
  orgId: string,
  orgName: string,
): Promise<Result<GeneratedDocument>> {
  const t = documentTranslator(input.messages);
  const brand = await loadDocumentBrand(input.db, orgId, orgName, (name) =>
    t("facts.logoAlt", { name }),
  );
  const project = "project" in data ? data.project : null;
  const now = input.now ?? new Date();
  const { recordKey } = DESCRIBE[kind](data, now);
  const model = buildDocumentModel(kind, data, {
    locale: input.locale,
    messages: input.messages,
    brand,
    recordUrl: input.recordUrl({ recordKey, projectKey: project?.key || null }),
    now,
    ...(input.watermark ? { watermark: input.watermark } : {}),
  });
  try {
    const bytes = await renderDocumentPdf(model, {
      paper: input.paper,
      ...(input.orientation ? { orientation: input.orientation } : {}),
    });
    return ok({
      bytes,
      fileName: documentFileName(kind, model.facts.recordKey, input.paper),
      templateVersion: model.facts.templateVersion,
    });
  } catch (error) {
    return fail({
      kind: "unexpected",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
