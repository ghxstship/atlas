import { documentTranslator, formatter } from "./format.ts";
import type { DocumentModel, Paper } from "./model.ts";
import { renderDocumentPdf } from "./render.ts";

/**
 * The deletion certificate (A79, Section 14.7): "At day 90, data is deleted, backups age out on their
 * schedule, and the Owner receives a deletion certificate." The platform issues it after the purge, when
 * the org and its brand are gone, so it carries the XOS name rather than a tenant brand. It renders through
 * the document pipeline of ADR 0031 (pdfkit, tagged PDF/UA-1) and is checked by veraPDF with the other
 * templates. Versioned like them: a change ships as a new version with a later effectiveFrom.
 */

export interface DeletionCertificateData {
  readonly id: string;
  readonly deletedOrgId: string;
  readonly orgName: string;
  readonly orgSlug: string;
  readonly basis: "cancellation" | "deletion_request";
  readonly requestedAt: string;
  readonly dueAt: string;
  readonly purgedAt: string;
  readonly tablesPurged: number;
  readonly rowsPurged: number;
  readonly storageObjectsDeleted: number;
  readonly ownerName: string | null;
  /** The deleted org's time zone (UTC when it never set one): the calendar the certificate dates on. */
  readonly timeZone: string;
}

export interface DeletionCertificateOptions {
  readonly locale: string;
  /** The `documents` namespace of the catalog in the certificate's language. */
  readonly messages: unknown;
  /** Where the former Owner opens their certificates (Atlas, signed in); drawn as the QR code. */
  readonly recordUrl: string;
  readonly now?: Date;
}

export const DELETION_CERTIFICATE_VERSIONS = [
  { version: 1, effectiveFrom: "2026-10-20T00:00:00Z" },
] as const;

/** The version a certificate issued at `issuedAt` renders with. */
export function deletionCertificateVersion(issuedAt: string): number {
  const at = Date.parse(issuedAt);
  let version: number = DELETION_CERTIFICATE_VERSIONS[0].version;
  for (const v of DELETION_CERTIFICATE_VERSIONS)
    if (Date.parse(v.effectiveFrom) <= at) version = v.version;
  return version;
}

/** The certificate key printed on every page: DEL- and the first 8 characters of the certificate id. */
export function certificateKey(id: string): string {
  return `DEL-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

export function buildDeletionCertificateModel(
  data: DeletionCertificateData,
  options: DeletionCertificateOptions,
): DocumentModel {
  const now = options.now ?? new Date();
  const t = documentTranslator(options.messages);
  const f = formatter(options.locale, data.timeZone, t);
  const key = certificateKey(data.id);
  const c = (k: string, values?: Record<string, string | number>) =>
    t(`deletionCertificate.${k}`, values);
  return {
    kind: "deletion-certificate",
    lang: options.locale,
    title: c("title", { org: data.orgName }),
    brand: { name: c("issuer"), legalEntity: null, accentHex: null, logo: null },
    facts: {
      recordKey: key,
      templateVersion: deletionCertificateVersion(data.purgedAt),
      generatedAt: f.dateTime(now.toISOString()),
      generatedAtIso: now.toISOString(),
      recordUrl: options.recordUrl,
      labels: {
        recordKey: c("key"),
        version: t("facts.version"),
        generatedAt: t("facts.generatedAt"),
        qrAlt: c("qrAlt", { key }),
        page: (page, total) => t("facts.page", { page, total }),
      },
    },
    blocks: [
      {
        kind: "paragraph",
        size: "large",
        text: c("statement", { org: data.orgName, date: f.dateTime(data.purgedAt) }),
      },
      {
        kind: "fields",
        caption: c("organization"),
        fields: [
          { label: c("orgName"), value: data.orgName },
          { label: c("orgSlug"), value: data.orgSlug },
          { label: c("orgId"), value: data.deletedOrgId },
          { label: c("issuedTo"), value: data.ownerName ?? c("formerOwner") },
        ],
      },
      {
        kind: "fields",
        caption: c("timeline"),
        fields: [
          {
            label: c(data.basis === "deletion_request" ? "requestedDeletion" : "canceled"),
            value: f.dateTime(data.requestedAt),
          },
          { label: c("due"), value: f.dateTime(data.dueAt) },
          { label: c("deleted"), value: f.dateTime(data.purgedAt) },
        ],
      },
      {
        kind: "table",
        caption: c("whatWasDeleted"),
        columns: [
          { label: c("what"), weight: 3 },
          { label: c("count"), numeric: true },
        ],
        rows: [
          [c("rows"), f.number(data.rowsPurged)],
          [c("tables"), f.number(data.tablesPurged)],
          [c("files"), f.number(data.storageObjectsDeleted)],
        ],
        empty: c("nothing"),
      },
      { kind: "heading", text: c("backupsTitle") },
      { kind: "paragraph", text: c("backups") },
      { kind: "paragraph", text: c("keep", { id: data.id }) },
    ],
  };
}

/** File name of a certificate PDF. */
export function deletionCertificateFileName(
  data: Pick<DeletionCertificateData, "id" | "orgSlug">,
  paper: Paper = "letter",
): string {
  const slug = data.orgSlug.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "org";
  return `deletion-certificate-${slug}-${certificateKey(data.id)}-${paper}.pdf`;
}

/** Renders the certificate to tagged PDF/UA-1. */
export async function renderDeletionCertificate(
  data: DeletionCertificateData,
  options: DeletionCertificateOptions & { readonly paper?: Paper },
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const model = buildDeletionCertificateModel(data, options);
  const paper = options.paper ?? "letter";
  return {
    bytes: await renderDocumentPdf(model, { paper }),
    fileName: deletionCertificateFileName(data, paper),
  };
}
