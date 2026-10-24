import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Resolution } from "./decision25.ts";
import type { SqlRow } from "./sql.ts";

/**
 * Owner decision 39 (2026-10-23, canon/rulings/decision-39.yaml; Linear RRR-66): the seven canon rulings
 * finding A56-001 asked for and the declared gaps of finding A65-019. Decision 25 left Bible
 * inconsistencies to the owner; each ruling here settles one, and an entry that no longer matches the
 * canon files is reported so a ruling never outlives the inconsistency it settles.
 */

export interface Decision39 {
  readonly decision: string;
  readonly decided_on: string;
  readonly linear: string;
  readonly accepted_findings: Readonly<Record<string, string>>;
  readonly phase_labels: readonly {
    readonly label: string;
    readonly phase_code: string;
    readonly note: string;
  }[];
  readonly role_department_labels: readonly {
    readonly dept_code: string;
    readonly stated: string;
    readonly label: string;
    readonly roles: readonly string[];
  }[];
  readonly item_department_labels: readonly {
    readonly stated: string;
    readonly label: string;
    readonly items: readonly string[];
  }[];
  readonly removed_statements: readonly {
    readonly tab: string;
    readonly columns?: readonly string[];
    readonly fields?: readonly string[];
  }[];
  readonly role_codes: {
    readonly owner: string;
    readonly retired: string;
    readonly library_only: readonly string[];
  };
  readonly gl_defaults: {
    /** Account types no class derives, so an item posting to one carries its own account. */
    readonly balance_sheet_types: readonly string[];
  };
  readonly unit_dimensions: readonly {
    readonly dimension_code: string;
    readonly name: string;
    readonly units: readonly string[];
  }[];
  readonly declared_gaps: {
    readonly ratified_by: string;
    readonly phases: readonly { readonly phase_code: string; readonly reason: string }[];
  };
}

const KEYS: readonly (keyof Decision39)[] = [
  "decision",
  "decided_on",
  "linear",
  "accepted_findings",
  "phase_labels",
  "role_department_labels",
  "item_department_labels",
  "removed_statements",
  "role_codes",
  "gl_defaults",
  "unit_dimensions",
  "declared_gaps",
];

export function parseDecision39(text: string): Decision39 {
  const doc = parse(text) as Partial<Decision39> | null;
  if (!doc || typeof doc !== "object") throw new Error("Decision 39 file is empty");
  const missing = KEYS.filter((k) => doc[k] === undefined);
  if (missing.length > 0) throw new Error(`Decision 39 file lacks ${missing.join(", ")}`);
  return doc as Decision39;
}

export function loadDecision39(canonDir: string): Decision39 {
  return parseDecision39(readFileSync(join(canonDir, "rulings", "decision-39.yaml"), "utf8"));
}

/** How the decision names itself in reasons and notes. */
export function rulingName(d39: Decision39): string {
  return `Owner decision 39 (${d39.decided_on}, ${d39.linear})`;
}

/** The gated phase a phase name means under the ruling, or undefined when the ruling names none. */
export function ruledPhase(
  d39: Decision39,
  label: string | null,
): Decision39["phase_labels"][number] | undefined {
  return label === null ? undefined : d39.phase_labels.find((p) => p.label === label);
}

/** The resolution of a difference a ruling settles. */
export function ruled(d39: Decision39, canon: string | null, note: string): Resolution {
  return { outcome: "ruled", basis: "owner-ruling", canon, note: `${rulingName(d39)}: ${note}` };
}

/** Columns of a Bible tab the ruling removes. */
export function removedColumns(d39: Decision39, tab: string): readonly string[] {
  return d39.removed_statements.find((r) => r.tab === tab)?.columns ?? [];
}

/** Fields of a Bible tab whose statement cell the ruling removes. */
export function removedFields(d39: Decision39, tab: string): readonly string[] {
  return d39.removed_statements.find((r) => r.tab === tab)?.fields ?? [];
}

/**
 * Entries of the decision the import applied, keyed as "<section>|<key>". Anything the file lists and the
 * import never applied is stale: the canon files changed under the ruling.
 */
export class RulingUse {
  readonly #used = new Set<string>();

  mark(section: string, key: string): void {
    this.#used.add(`${section}|${key}`);
  }

  has(section: string, key: string): boolean {
    return this.#used.has(`${section}|${key}`);
  }
}

/** Every entry of the decision file, as the section and key RulingUse records. */
export function rulingEntries(d39: Decision39): { section: string; key: string }[] {
  return [
    ...d39.phase_labels.map((p) => ({ section: "phase_labels", key: p.label })),
    ...d39.role_department_labels.flatMap((r) =>
      r.roles.map((key) => ({ section: "role_department_labels", key })),
    ),
    ...d39.item_department_labels.flatMap((i) =>
      i.items.map((key) => ({ section: "item_department_labels", key })),
    ),
    ...d39.removed_statements.flatMap((r) => [
      ...(r.columns ?? []).map((c) => ({ section: "removed_statements", key: `${r.tab} ${c}` })),
      ...(r.fields ?? []).map((f) => ({ section: "removed_statements", key: `${r.tab} ${f}` })),
    ]),
    ...d39.role_codes.library_only.map((key) => ({ section: "role_codes", key })),
    ...d39.unit_dimensions.flatMap((d) =>
      d.units.map((key) => ({ section: "unit_dimensions", key })),
    ),
    ...d39.declared_gaps.phases.map((g) => ({ section: "declared_gaps", key: g.phase_code })),
  ];
}

/** Decision entries nothing applied any more, leaving out the sections another step applies. */
export function staleRulings(
  d39: Decision39,
  use: RulingUse,
  elsewhere: readonly string[] = [],
): string[] {
  return rulingEntries(d39)
    .filter((e) => !elsewhere.includes(e.section) && !use.has(e.section, e.key))
    .map((e) => `Decision 39 entry no longer matches the canon files: ${e.section} ${e.key}`);
}

/** xpms.dim_unit_dimension rows the decision ratifies. */
export function unitDimensionRows(d39: Decision39): SqlRow[] {
  return d39.unit_dimensions.map((d) => ({ dimension_code: d.dimension_code, name: d.name }));
}

/**
 * A Standard Library unit label that resolves only because the ruling adds its unit (Hour and Week): its mapping
 * names decision 39 rather than decision 25's casing rule. Undefined for a unit the Item Catalog already states.
 */
export function addedUnitLabel(
  d39: Decision39,
  label: string,
  unit: string,
  catalogUnits: ReadonlySet<string>,
): Resolution | undefined {
  const dimension = d39.unit_dimensions.find((d) => d.units.includes(unit));
  if (dimension === undefined || catalogUnits.has(unit)) return undefined;
  return {
    outcome: "mapped-to-existing",
    basis: "casing-or-punctuation",
    canon: unit,
    decision: d39.decision,
    note: `${rulingName(d39)}: the ${dimension.name.toLowerCase()} dimension adds ${unit} as a canon unit, so Unit of Measure ${label} resolves to it.`,
  };
}

/** The ratified dimension of a unit, or null. */
export function unitDimension(d39: Decision39, unit: string): string | null {
  return d39.unit_dimensions.find((d) => d.units.includes(unit))?.dimension_code ?? null;
}
