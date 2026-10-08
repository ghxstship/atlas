import { scanText } from "@xos/config/finish-guard";

/**
 * Doctrine findings. Canon values are never changed silently: every value the
 * importer has to adjust or cannot resolve is recorded here, written to
 * canon/reports/doctrine-findings.md and listed for an owner decision.
 */

export type FindingKind =
  "em-dash-substituted" | "guard-reserved-word" | "unresolved-reference" | "structure" | "conflict";

export interface Finding {
  readonly kind: FindingKind;
  /** Where the value lives, such as "Bible 16 · Metrics row 5 item". */
  readonly location: string;
  readonly detail: string;
}

export class Findings {
  readonly #items: Finding[] = [];

  add(kind: FindingKind, location: string, detail: string): void {
    this.#items.push({ kind, location, detail });
  }

  get items(): readonly Finding[] {
    return this.#items;
  }

  ofKind(kind: FindingKind): Finding[] {
    return this.#items.filter((f) => f.kind === kind);
  }
}

export const EM_DASH = String.fromCharCode(0x2014);
const EM_DASH_RUN = new RegExp(`\\s*${EM_DASH}\\s*`, "g");

/**
 * Section 3.6 forbids em dashes in seed data. The house style of the canon
 * files writes the same separator as a spaced hyphen ("Tier 1 - Executive
 * Master"), so an em dash becomes " - " and the substitution is reported.
 */
export function substituteEmDash(value: string): string {
  return value.replace(EM_DASH_RUN, " - ");
}

export function canonText(value: string, location: string, findings: Findings): string {
  if (!value.includes(EM_DASH)) return value;
  const replaced = substituteEmDash(value);
  findings.add(
    "em-dash-substituted",
    location,
    `Em dash replaced by a spaced hyphen: "${value.replace(new RegExp(EM_DASH, "g"), "<em dash>")}" is stored as "${replaced}"`,
  );
  return replaced;
}

/**
 * True when a value would trip the repository finish guard (Section 18, gate 2)
 * if written into a migration as a plain literal. The guard's own scanner
 * decides, so the importer and the guard can never disagree.
 */
export function guardRules(value: string): string[] {
  return scanText("supabase/migrations/seed.sql", value).map((f) => f.rule);
}
