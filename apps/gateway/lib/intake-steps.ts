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

/** Major units as typed, to minor units for a currency's exponent; null when blank or not a number. */
export function toMinorUnits(value: string, exponent = 2): number | null {
  const trimmed = value.trim();
  if (trimmed === "" || !/^\d+(\.\d+)?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 10 ** exponent);
}
