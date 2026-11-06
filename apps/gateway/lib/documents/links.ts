import type { ExternalDocumentKind } from "@xos/data/documents/sources-external";
import { tabHref } from "@/lib/engagement";

/** The engagement tab that lists each Gateway document's record. */
const TAB: Readonly<Record<ExternalDocumentKind, string>> = {
  "purchase-order": "engagement.purchase-orders",
  invoice: "engagement.invoices",
  "change-order": "engagement.change-orders",
  "run-of-show": "engagement.run-of-show",
  "credential-badge": "engagement.credentials",
  quote: "engagement.documents",
};

/**
 * The route that answers a Gateway document as a tagged PDF (app/documents/[kind]/[id]). The
 * engagement key only shapes the QR link back to the tab; access comes from the api_external views.
 */
export function documentHref(
  kind: ExternalDocumentKind,
  id: string,
  engagementKey: string,
): string {
  return `/documents/${kind}/${encodeURIComponent(id)}?engagement=${encodeURIComponent(engagementKey)}`;
}

/** Where the record opens in Gateway: its engagement tab, or Work when the engagement is unknown. */
export function gatewayRecordPath(
  kind: ExternalDocumentKind,
  engagementKey: string | null,
): string {
  return engagementKey ? tabHref(engagementKey, TAB[kind]) : "/work";
}

/**
 * Whether a document can be signed with one click on a list. A Quote never can: it is a commercial
 * commitment, signed only after its total, valid-until date and consent sentence are shown (S14.5-01).
 */
export function signsInOneClick(document: {
  readonly kind: string;
  readonly state: string;
}): boolean {
  return document.state === "Sent" && document.kind !== "Quote";
}

/**
 * Where a PDF from a signing link points: Gateway's Documents page, never the link. A link's token is
 * one of its two secrets, and the PDF is meant to be forwarded.
 */
export const TOKEN_DOCUMENT_RECORD_PATH = "/documents";
