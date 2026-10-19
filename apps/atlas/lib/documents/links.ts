import type { DocumentKind } from "@xos/data/documents/model";

/** The route that answers a generated document as a tagged PDF (app/[org]/documents/[kind]/[id]). */
export function documentHref(org: string, kind: DocumentKind, id: string): string {
  return `/${encodeURIComponent(org)}/documents/${kind}/${encodeURIComponent(id)}`;
}

/**
 * Where each document's record opens in Atlas: the page and query the record view reads. The QR
 * code on the document links here, so anyone with access lands on the record (Section 11.9).
 */
export function atlasRecordPath(
  org: string,
  kind: DocumentKind,
  record: { readonly id: string; readonly recordKey: string; readonly projectKey: string | null },
): string {
  const o = `/${encodeURIComponent(org)}`;
  const id = encodeURIComponent(record.id);
  switch (kind) {
    case "purchase-order":
      return `${o}/procurement/purchase-orders?peek=${id}&full=1`;
    case "invoice":
      return `${o}/finance/invoices?peek=${id}`;
    case "change-order":
      return `${o}/finance/change-orders?peek=${id}`;
    case "day-sheet":
      return `${o}/show/day-sheets?peek=${id}`;
    case "call-sheet":
      return `${o}/show/call-sheets?peek=${id}`;
    case "run-of-show":
      return `${o}/show/run-of-show?peek=${id}`;
    case "beo":
      return `${o}/hospitality/beos?peek=${encodeURIComponent(record.recordKey)}`;
    case "credential-badge":
      return `${o}/credentials/issued?peek=${id}`;
    case "inspection-report":
      return `${o}/safety/inspections?peek=${id}&full=1`;
    case "incident-report":
      return `${o}/safety/incidents?peek=${id}`;
    case "final-cost-report":
      return `${o}/reports/final-cost-report?project=${encodeURIComponent(record.projectKey ?? "")}`;
    case "agreement-certificate":
      return `${o}/people/agreements?peek=${id}`;
  }
}
