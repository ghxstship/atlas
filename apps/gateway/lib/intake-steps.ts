import { minorDigits, parseMoneyInput } from "@/lib/format";

/**
 * The vendor intake wizard's plan (B2, ADR 0141), pure so its rules are unit tested. A step for each thing the link
 * collects, then Review, which holds the screen's one primary action. Each step is one form with at most seven fields
 * (gate 27).
 */

export type IntakeStep = "company" | "tax" | "payout" | "agreement" | "invoice" | "review";

export function intakeSteps(link: {
  readonly roleType: "Vendor" | "Contractor";
  readonly collectTaxForm: boolean;
  readonly collectPayout: boolean;
  readonly collectInvoice: boolean;
  readonly agreement: unknown;
}): readonly IntakeStep[] {
  return [
    ...(link.roleType === "Vendor" ? (["company"] as const) : []),
    ...(link.collectTaxForm ? (["tax"] as const) : []),
    ...(link.collectPayout ? (["payout"] as const) : []),
    ...(link.agreement ? (["agreement"] as const) : []),
    ...(link.collectInvoice ? (["invoice"] as const) : []),
    "review",
  ];
}

/** The tax forms offered: W-9 or W-8BEN-E for an account, W-9 or W-8BEN for a person. */
export function intakeTaxKinds(asAccount: boolean): readonly string[] {
  return asAccount ? ["W-9", "W-8BEN-E"] : ["W-9", "W-8BEN"];
}

/** Today in a zone, as a date input wants it. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(now);
}

/**
 * A unit price as typed, in the invoice's currency: its minor units (Section 3.11, so 1000 JPY is 1000 and 12.500 KWD is
 * 12500), null when left blank for an unpriced line, or "invalid" when it is not a plain amount that currency can hold.
 * The currency is required, since a default would put every price a hundred times out in some currencies.
 */
export function parseLinePrice(text: string, currency: string): number | null | "invalid" {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const decimals = trimmed.split(".")[1]?.length ?? 0;
  if (!/^(\d+|\d{1,3}(,\d{3})+)?(\.\d+)?$/.test(trimmed) || decimals > minorDigits(currency)) {
    return "invalid";
  }
  const minor = parseMoneyInput(trimmed, currency);
  return minor !== null && Number.isSafeInteger(minor) ? minor : "invalid";
}
