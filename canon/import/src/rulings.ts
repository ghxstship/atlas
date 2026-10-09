import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * Owner canon rulings (canon/rulings/owner-rulings.yaml): decisions D11 to D17
 * and D19 from the design system handoff. They hold only values no canon file
 * states; the importer applies them and reports every Playbook row they change.
 */

export interface Rulings {
  readonly grades: readonly {
    code: string;
    label: string;
    sort_order: number;
    catalog_column: string;
  }[];
  readonly overtime_rules: readonly {
    rule_id: string;
    name: string;
    ot_multiplier: string;
    dt_multiplier: string;
  }[];
  readonly worker_classifications: readonly {
    code: string;
    label: string;
    is_employee: boolean;
    payment_channel: string;
    sort_order: number;
  }[];
  readonly classification_documents: readonly [string, string, string, string][];
  readonly pay_bases: readonly string[];
  readonly arrangements: readonly string[];
  readonly pay_basis_classifications: readonly [string, string][];
  readonly arrangement_classifications: readonly [string, string][];
  readonly engagement_types: Readonly<
    Record<string, { worker_classification: string; arrangement: string }>
  >;
  readonly organization_types: readonly string[];
  readonly classification_organization_types: readonly [string, string][];
  readonly wage_hour_rules: readonly Record<string, string | null>[];
  readonly emergency_service_tokens: readonly [string, string][];
  readonly agency_functions: readonly [string, string, boolean, number][];
  readonly jurisdiction_agencies: readonly [string, string, string, string | null][];
  readonly retired_enumeration_domains: readonly string[];
}

const KEYS: readonly (keyof Rulings)[] = [
  "grades",
  "overtime_rules",
  "worker_classifications",
  "classification_documents",
  "pay_bases",
  "arrangements",
  "pay_basis_classifications",
  "arrangement_classifications",
  "engagement_types",
  "organization_types",
  "classification_organization_types",
  "wage_hour_rules",
  "emergency_service_tokens",
  "agency_functions",
  "jurisdiction_agencies",
  "retired_enumeration_domains",
];

export function parseRulings(text: string): Rulings {
  const doc = parse(text) as Partial<Rulings> | null;
  if (!doc || typeof doc !== "object") throw new Error("Rulings file is empty");
  const missing = KEYS.filter((k) => doc[k] === undefined);
  if (missing.length > 0) throw new Error(`Rulings file lacks ${missing.join(", ")}`);
  return doc as Rulings;
}

export function loadRulings(canonDir: string): Rulings {
  return parseRulings(readFileSync(join(canonDir, "rulings", "owner-rulings.yaml"), "utf8"));
}
