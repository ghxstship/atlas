import type { RecordState } from "@xos/ui";
import type {
  ApplicationState,
  DeliverableState,
  EngagementDocumentState,
  EngagementState,
  OfferState,
  OpportunityState,
} from "@xos/data/opportunities";

/**
 * Display helpers for the Opportunities pages. Every lifecycle maps onto the shared record state icons (Section 3.10)
 * with its own label from the catalog; money is stored in integer minor units and shown with the currency's own
 * number of fraction digits; NULL money reads as Rate on Request or unpriced, never zero (Section 3.7).
 */

export function opportunityIcon(state: OpportunityState): RecordState {
  switch (state) {
    case "Draft":
      return "proposed";
    case "Pending Approval":
      return "in-review";
    case "Published":
      return "active";
    case "Paused":
      return "blocked";
    case "Filled":
    case "Closed":
      return "complete";
    case "Canceled":
      return "canceled";
  }
}

export function applicationIcon(state: ApplicationState): RecordState {
  switch (state) {
    case "Submitted":
      return "proposed";
    case "In Review":
      return "in-review";
    case "Shortlisted":
      return "ready";
    case "Offered":
      return "scheduled";
    case "Accepted":
      return "complete";
    case "Declined":
    case "Withdrawn":
    case "Not Selected":
      return "canceled";
  }
}

export function engagementIcon(state: EngagementState): RecordState {
  switch (state) {
    case "Onboarding":
      return "proposed";
    case "Blocked":
      return "blocked";
    case "Active":
      return "active";
    case "Closing":
      return "in-review";
    case "Complete":
      return "complete";
    case "Canceled":
      return "canceled";
  }
}

export function documentIcon(state: EngagementDocumentState): RecordState {
  switch (state) {
    case "Proposed":
      return "proposed";
    case "Sent":
      return "in-review";
    case "Signed":
      return "ready";
    case "Executed":
      return "complete";
    case "Expired":
    case "Superseded":
      return "deferred";
    case "Canceled":
      return "canceled";
  }
}

export function offerIcon(state: OfferState): RecordState {
  switch (state) {
    case "Sent":
      return "in-review";
    case "Countered":
      return "blocked";
    case "Accepted":
      return "complete";
    case "Declined":
    case "Withdrawn":
      return "canceled";
    case "Expired":
      return "deferred";
  }
}

export function deliverableIcon(state: DeliverableState): RecordState {
  switch (state) {
    case "Open":
      return "proposed";
    case "Submitted":
      return "in-review";
    case "Accepted":
      return "complete";
    case "Returned":
      return "blocked";
  }
}

/** An enum display value to its catalog key: `Pending Approval` to `pendingApproval`. */
export function enumKey(value: string): string {
  return value
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(" ")
    .filter((w) => w.length > 0)
    .map((w, i) =>
      i === 0 ? w.toLowerCase() : `${w.charAt(0).toUpperCase()}${w.slice(1).toLowerCase()}`,
    )
    .join("");
}

/** Fraction digits of a currency, from the platform's own Intl data (2 for USD, 0 for JPY). */
export function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** Minor units to a localized amount; null stays null so the caller says Rate on Request or unpriced. */
export function formatMoney(
  locale: string,
  minor: number | null,
  currency: string | null,
): string | null {
  if (minor === null || currency === null) return null;
  const digits = currencyDigits(currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
  }).format(minor / 10 ** digits);
}

/** A typed amount in major units ("950.00") to integer minor units; null for blank input, NaN for invalid input. */
export function parseMoney(input: string | null | undefined, currency: string): number | null {
  const text = (input ?? "").trim().replace(/,/g, "");
  if (text === "") return null;
  if (!/^\d+(\.\d+)?$/.test(text)) return Number.NaN;
  const digits = currencyDigits(currency);
  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > digits) return Number.NaN;
  return Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0");
}

/** A posted pay range as one string, or null when no compensation is posted (Rate on Request). */
export function formatPayRange(
  locale: string,
  min: number | null,
  max: number | null,
  currency: string | null,
  range: (low: string, high: string) => string,
): string | null {
  const low = formatMoney(locale, min, currency);
  const high = formatMoney(locale, max, currency);
  if (low && high) return low === high ? low : range(low, high);
  return low ?? high;
}
