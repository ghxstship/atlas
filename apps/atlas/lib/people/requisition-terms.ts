import type { Translate } from "@/lib/shell/translate";

/**
 * A requisition's terms (People > Requisitions): a worker classification, pay basis and arrangement from a canon
 * Labor Rate Card row of the role. Each part reads in words (crawl 4.9 showed "EMPLOYEE" and "INDEPENDENT_CONTRACTOR"),
 * and the choices are the chosen role's rows, each combination once (the canon repeats a combination across rate card
 * rows that differ only in their overtime rule).
 */

export interface TermsParts {
  readonly classification: string | null;
  readonly payBasis: string | null;
  readonly arrangement: string | null;
}

export interface RateCardRow extends TermsParts {
  readonly roleCode: string;
}

/** Catalog keys under people.requisitions of the canon values (xpms.worker_classification, pay_basis, arrangement). */
const CLASSIFICATIONS: Readonly<Record<string, string>> = {
  EMPLOYEE: "employee",
  INDEPENDENT_CONTRACTOR: "independentContractor",
  VENDOR_SUPPLIED: "vendorSupplied",
  UNPAID_INTERN: "unpaidIntern",
  VOLUNTEER: "volunteer",
};
const PAY_BASES: Readonly<Record<string, string>> = {
  "Day Rate": "dayRate",
  "Flat Fee": "flatFee",
  Hourly: "hourly",
  Salary: "salary",
};
const ARRANGEMENTS: Readonly<Record<string, string>> = {
  "Per Engagement": "perEngagement",
  Retainer: "retainer",
};

function part(
  t: Translate,
  group: string,
  keys: Readonly<Record<string, string>>,
  value: string | null,
) {
  if (value === null) return "";
  const key = keys[value];
  // A canon value added after this list still shows, as the canon spells it.
  return key ? t(`people.requisitions.${group}.${key}`) : value;
}

/** The form value of a combination: classification, pay basis and arrangement joined by "|". */
export function termsValue(parts: TermsParts): string {
  return `${parts.classification ?? ""}|${parts.payBasis ?? ""}|${parts.arrangement ?? ""}`;
}

/** "Employee · Day Rate · Per Engagement" in the reader's language. */
export function termsLabel(t: Translate, parts: TermsParts): string {
  return t("people.requisitions.termsValue", {
    classification: part(t, "classifications", CLASSIFICATIONS, parts.classification),
    basis: part(t, "payBases", PAY_BASES, parts.payBasis),
    arrangement: part(t, "arrangements", ARRANGEMENTS, parts.arrangement),
  });
}

/** The terms a role offers, by role code: that role's rate card rows, each combination once, in canon order. */
export function termsOptionsByRole(
  t: Translate,
  rows: readonly RateCardRow[],
): Record<string, Array<{ value: string; label: string }>> {
  const byRole: Record<string, Array<{ value: string; label: string }>> = {};
  for (const row of rows) {
    const options = (byRole[row.roleCode] ??= []);
    const value = termsValue(row);
    if (!options.some((o) => o.value === value)) options.push({ value, label: termsLabel(t, row) });
  }
  return byRole;
}
