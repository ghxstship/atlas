/**
 * The generated document model (Section 11.9, ADR 0031). A template version turns record data into
 * this model; the renderer turns the model into a tagged PDF/UA-1 file. The model holds only text
 * the reader sees, already translated and formatted, in reading order, so the structure tree the
 * renderer writes follows the same order as the page.
 */

/** The twelve Section 11.9 documents. */
export const DOCUMENT_KINDS = [
  "purchase-order",
  "invoice",
  "change-order",
  "day-sheet",
  "call-sheet",
  "run-of-show",
  "beo",
  "credential-badge",
  "inspection-report",
  "incident-report",
  "final-cost-report",
  "agreement-certificate",
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export function isDocumentKind(value: string): value is DocumentKind {
  return (DOCUMENT_KINDS as readonly string[]).includes(value);
}

/**
 * Documents the platform issues outside any org's records (A79): the deletion certificate of an org whose
 * data was deleted (Section 14.7). They use the same renderer and model, so they meet PDF/UA-1 too.
 */
export const PLATFORM_DOCUMENT_KINDS = ["deletion-certificate"] as const;

export type PlatformDocumentKind = (typeof PLATFORM_DOCUMENT_KINDS)[number];

/** Every document prints on US Letter and A4 (Section 11.9). */
export type Paper = "letter" | "a4";

export const PAPERS: readonly Paper[] = ["letter", "a4"];

export function isPaper(value: string): value is Paper {
  return (PAPERS as readonly string[]).includes(value);
}

/** A label and its value, read as a row header and its cell. */
export interface DocumentField {
  readonly label: string;
  readonly value: string;
}

export interface DocumentColumn {
  readonly label: string;
  /** Numbers and money align to the end of the cell. */
  readonly numeric?: boolean;
  /** Relative width; columns share the line by weight. Defaults to 1. */
  readonly weight?: number;
}

export type DocumentBlock =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string; readonly size?: "body" | "large" }
  | { readonly kind: "fields"; readonly caption: string; readonly fields: readonly DocumentField[] }
  | {
      readonly kind: "table";
      readonly caption: string;
      readonly columns: readonly DocumentColumn[];
      readonly rows: readonly (readonly string[])[];
      /** Totals rows after the body, still in the same table. */
      readonly footer?: readonly (readonly string[])[];
      /** Shown in place of the table when it has no rows. */
      readonly empty: string;
    };

export interface DocumentLogo {
  /** PNG or JPEG bytes. Other formats fall back to the brand name in text. */
  readonly bytes: Uint8Array;
  readonly alt: string;
}

export interface DocumentModel {
  readonly kind: DocumentKind | PlatformDocumentKind;
  /** BCP 47 language of every string in the model, for example en-US or es-US. */
  readonly lang: string;
  /** Document title, also the PDF title the viewer shows (for example "Purchase order PRJ-PO-12"). */
  readonly title: string;
  /** The tenant brand: display name, legal entity and optional logo. */
  readonly brand: {
    readonly name: string;
    readonly legalEntity: string | null;
    /** Brand accent as #rrggbb, used for the rule under the header only. */
    readonly accentHex: string | null;
    readonly logo: DocumentLogo | null;
  };
  /** The facts every document shows: record key, version, generation time and the record link. */
  readonly facts: {
    readonly recordKey: string;
    readonly templateVersion: number;
    /** Generation time as the reader sees it, in the record's time zone. */
    readonly generatedAt: string;
    /** The same instant as ISO 8601, for the PDF metadata. */
    readonly generatedAtIso: string;
    /** Opens the record for anyone with access; drawn as a QR code and printed as text. */
    readonly recordUrl: string;
    /** Translated labels for the facts block. */
    readonly labels: {
      readonly recordKey: string;
      readonly version: string;
      readonly generatedAt: string;
      readonly qrAlt: string;
      readonly page: (page: number, total: number) => string;
    };
  };
  readonly blocks: readonly DocumentBlock[];
}
