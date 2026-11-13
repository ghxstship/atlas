import { addCalendarDays } from "@xos/data/calendar";
import { invoiceTrackerStep, type Engagement } from "@xos/data/gateway";
import { UNPAID_ROLE_TYPES } from "@/lib/engagement-state";
import type { Translate } from "@/lib/shell/translate";
import type { Tone } from "@/lib/states";

/**
 * What the party reads about its invoices, payments and insurance certificates (crawl 4.9). The
 * stored lifecycle states are the org's bookkeeping: a party's submitted invoice is Proposed until
 * the org approves it, payment is not an invoice state at all, and an Approved payment is money the
 * org sent. Gateway shows the party the tracker's own words instead, and dates a certificate
 * against today, so one not yet in force never reads Expired.
 */

/** Role types that submit invoices to the org: everyone it pays (ADR 0019 decision 69). */
export const INVOICING_ROLE_TYPES: readonly Engagement["roleType"][] = [
  "Contractor",
  "Crew",
  "Staff",
  "Vendor",
  "Artist",
];

/** Whether the engagement submits its own invoices; a client or sponsor never does. */
export function submitsInvoices(roleType: Engagement["roleType"]): boolean {
  return INVOICING_ROLE_TYPES.includes(roleType) && !UNPAID_ROLE_TYPES.includes(roleType);
}

/** Catalog key of the engagement Invoices tab when it lists no invoice. */
export function engagementInvoicesEmptyKey(roleType: Engagement["roleType"]): string {
  return submitsInvoices(roleType)
    ? "gateway.engagement.invoices.empty"
    : "gateway.engagement.invoices.emptyUnpaid";
}

/** Catalog key of Money, Invoices when it lists no invoice, by whether the person does paid work. */
export function moneyInvoicesEmptyKey(paidWork: boolean): string {
  return paidWork ? "gateway.money.invoices.empty" : "gateway.money.invoices.emptyUnpaid";
}

export type PartyInvoiceStatus =
  "submitted" | "issued" | "approved" | "scheduled" | "paid" | "disputed" | "canceled";

/** The invoice's status in the payment tracker's words: Submitted, Approved, Scheduled, Paid. */
export function partyInvoiceStatus(
  row: Parameters<typeof invoiceTrackerStep>[0],
): PartyInvoiceStatus {
  if (row.invoice_state === "Canceled") return "canceled";
  if (row.invoice_state === "Disputed") return "disputed";
  const step = invoiceTrackerStep(row);
  if (step === 3) return "paid";
  if (step === 2) return "scheduled";
  if (step === 1) return "approved";
  // An invoice the org sends (a receivable) is Issued; one the party submitted waits for approval.
  return row.invoice_state === "Issued" ? "issued" : "submitted";
}

const INVOICE_TONE: Readonly<Record<PartyInvoiceStatus, Tone>> = {
  submitted: "accent",
  issued: "accent",
  approved: "accent",
  scheduled: "accent",
  paid: "success",
  disputed: "danger",
  canceled: "neutral",
};

export function partyInvoiceTone(status: PartyInvoiceStatus): Tone {
  return INVOICE_TONE[status];
}

export function partyInvoiceStatusKey(status: PartyInvoiceStatus): string {
  return `gateway.money.invoices.status.${status}`;
}

export type PartyPaymentStatus = "scheduled" | "paid" | "canceled";

/** A payment the org recorded and approved has been paid; the party never sees one still Proposed. */
export function partyPaymentStatus(state: string): PartyPaymentStatus {
  if (state === "Approved") return "paid";
  if (state === "Canceled") return "canceled";
  return "scheduled";
}

export function partyPaymentStatusKey(status: PartyPaymentStatus): string {
  return `gateway.money.payments.status.${status}`;
}

export function partyPaymentTone(status: PartyPaymentStatus): Tone {
  return status === "paid" ? "success" : status === "canceled" ? "neutral" : "accent";
}

/** Days before a certificate's end date when it reads Expiring soon. */
export const CERTIFICATE_EXPIRING_DAYS = 30;

export type CertificateStatus = "notYetInForce" | "current" | "expiringSoon" | "expired";

/**
 * A certificate of insurance against today (`YYYY-MM-DD`): not yet in force before it starts,
 * expired after it ends, expiring soon in its last 30 days, and current otherwise. Dates are
 * calendar days, both ends included, as the view's `is_current`.
 */
export function certificateStatus(
  c: { readonly valid_from: string | null; readonly valid_to: string | null },
  today: string,
): CertificateStatus {
  const from = c.valid_from?.slice(0, 10) ?? null;
  const to = c.valid_to?.slice(0, 10) ?? null;
  if (from !== null && today < from) return "notYetInForce";
  if (to !== null && today > to) return "expired";
  if (to !== null && to <= addCalendarDays(today, CERTIFICATE_EXPIRING_DAYS)) return "expiringSoon";
  return "current";
}

/** The certificate's tag: its status, dated where the date is the point. */
export function certificateTag(
  c: { readonly valid_from: string | null; readonly valid_to: string | null },
  today: string,
  t: Translate,
  date: (iso: string) => string,
): { readonly label: string; readonly tone: Tone } {
  const status = certificateStatus(c, today);
  switch (status) {
    case "notYetInForce":
      return {
        label: t("gateway.engagement.compliance.startsOn", { date: date(c.valid_from ?? "") }),
        tone: "warning",
      };
    case "expiringSoon":
      return {
        label: t("gateway.engagement.compliance.expiresOn", { date: date(c.valid_to ?? "") }),
        tone: "warning",
      };
    case "expired":
      return { label: t("gateway.engagement.compliance.expired"), tone: "danger" };
    case "current":
      return { label: t("gateway.engagement.compliance.current"), tone: "success" };
  }
}
