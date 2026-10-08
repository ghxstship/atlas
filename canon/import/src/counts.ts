/**
 * Count validation (Section 2). Each entity's parsed row count must equal the
 * count the build contract states, and, where the Bible states its own count
 * in the _generated tab, that count too. A mismatch stops the import.
 */

export interface CountRule {
  readonly entity: string;
  /** Bible tab number, or the CSV role for file-sourced entities. */
  readonly source: string;
  readonly expected: number;
  /** Key in the Bible's _generated tab that states the same count, if any. */
  readonly generatedKey?: string;
}

export const COUNT_RULES: readonly CountRule[] = [
  { entity: "departments", source: "01", expected: 10, generatedKey: "departments" },
  { entity: "disciplines", source: "02", expected: 114, generatedKey: "disciplines" },
  { entity: "categories", source: "03", expected: 291, generatedKey: "categories" },
  { entity: "acts", source: "04", expected: 3 },
  { entity: "phases", source: "05", expected: 9 },
  { entity: "gate criteria", source: "06", expected: 35, generatedKey: "gate_criteria" },
  { entity: "tiers", source: "07", expected: 6 },
  { entity: "tags", source: "09", expected: 42 },
  { entity: "touchpoints", source: "10", expected: 90, generatedKey: "touchpoints" },
  { entity: "jurisdictions", source: "11", expected: 7 },
  { entity: "regions", source: "12", expected: 5 },
  { entity: "permit rules", source: "15", expected: 22 },
  { entity: "metrics", source: "16", expected: 39 },
  { entity: "record kinds", source: "24", expected: 26 },
  { entity: "record subtypes", source: "25", expected: 124 },
  { entity: "record states", source: "26", expected: 9 },
  { entity: "roles", source: "27", expected: 61 },
  { entity: "counterparty types", source: "28", expected: 22 },
  { entity: "GL accounts", source: "29", expected: 23, generatedKey: "gl_accounts" },
  { entity: "GL accounts (CSV)", source: "gl-chart", expected: 23 },
  { entity: "items", source: "32", expected: 1211, generatedKey: "items" },
  { entity: "items (CSV)", source: "item-catalog", expected: 1211 },
];

export interface CountResult {
  readonly entity: string;
  readonly source: string;
  readonly expected: number;
  readonly parsed: number;
  readonly stated: number | null;
  readonly ok: boolean;
}

export function validateCounts(
  parsed: ReadonlyMap<string, number>,
  generated: ReadonlyMap<string, string>,
): CountResult[] {
  return COUNT_RULES.map((rule) => {
    const n = parsed.get(rule.source);
    if (n === undefined) throw new Error(`No parsed count for source ${rule.source}`);
    const statedText =
      rule.generatedKey === undefined ? undefined : generated.get(rule.generatedKey);
    const stated = statedText === undefined ? null : Number(statedText);
    const ok = n === rule.expected && (stated === null || stated === n);
    return {
      entity: rule.entity,
      source: rule.source,
      expected: rule.expected,
      parsed: n,
      stated,
      ok,
    };
  });
}

export function countFailures(results: readonly CountResult[]): string[] {
  return results
    .filter((r) => !r.ok)
    .map((r) => {
      const stated = r.stated === null ? "" : `, the Bible states ${r.stated}`;
      return `Count mismatch for ${r.entity} (source ${r.source}): expected ${r.expected}, parsed ${r.parsed}${stated}`;
    });
}
