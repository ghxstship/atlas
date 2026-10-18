import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readColumnMap } from "../src/playbook/column-map.ts";

/**
 * Section 18 gate 14: every `field` target in the Playbook column map exists in the schema. The schema is read
 * from the generated database types (`packages/data/src/database.types.ts`, regenerated from the migrations and
 * diffed in CI), so this runs without a database.
 *
 * Standard Library and Production Template targets (`xpms.*`) are generated from the map and must all resolve.
 * Most targets in `app.*` were written as `<entity>.<column key>` skeletons before the domain schema existed and
 * name columns the domain tables never got (finding legal/qa/findings/A47-001.md). Until the map is reconciled,
 * UNRESOLVED_APP_TARGETS holds the measured count per table, like the bundle ceilings: the test fails when a
 * table gains an unresolved target, and also when one resolves, so the count is lowered as the map is fixed.
 */
const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

const UNRESOLVED_APP_TARGETS: Readonly<Record<string, number>> = {
  "app.access_grid": 12,
  "app.activity_events": 18,
  "app.advance_submissions": 23,
  "app.asset_custody": 11,
  "app.asset_units": 13,
  "app.budget_lines": 25,
  "app.change_orders": 22,
  "app.credentials": 15,
  "app.cues": 20,
  "app.fulfillments": 18,
  "app.incidents": 21,
  "app.inspections": 20,
  "app.marshalling_log": 21,
  "app.po_lines": 9,
  "app.posting_lines": 2,
  "app.projects": 15,
  "app.purchase_orders": 11,
  "app.records": 66,
  "app.requisitions": 6,
  "app.role_assignments": 25,
  "app.shifts": 12,
  "app.shipments": 29,
  "app.spaces": 9,
  "app.timesheets": 9,
  "app.vendors": 23,
};

/** Every `schema.relation.column` of a table or view Row in the generated database types. */
export function schemaColumns(types: string): Set<string> {
  const columns = new Set<string>();
  let schema = "";
  let section = "";
  let relation = "";
  let inRow = false;
  for (const line of types.split("\n")) {
    const schemaMatch = /^ {2}([a-z_]+): \{$/.exec(line);
    if (schemaMatch) {
      schema = schemaMatch[1] as string;
      continue;
    }
    const sectionMatch = /^ {4}(Tables|Views|Functions|Enums|CompositeTypes): \{$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1] as string;
      continue;
    }
    if (section !== "Tables" && section !== "Views") continue;
    const relationMatch = /^ {6}([a-z0-9_]+): \{$/.exec(line);
    if (relationMatch) {
      relation = relationMatch[1] as string;
      continue;
    }
    if (/^ {8}Row: \{$/.test(line)) {
      inRow = true;
      continue;
    }
    if (inRow && /^ {8}\}/.test(line)) {
      inRow = false;
      continue;
    }
    const columnMatch = /^ {10}([a-z0-9_]+)\??:/.exec(line);
    if (inRow && columnMatch) columns.add(`${schema}.${relation}.${columnMatch[1] as string}`);
  }
  return columns;
}

const columns = schemaColumns(readFileSync(repo("packages/data/src/database.types.ts"), "utf8"));
const fieldTargets = readColumnMap(readFileSync(repo("canon/map/playbook-columns.yaml"), "utf8"))
  .sheets.flatMap((s) => s.columns)
  .filter((c) => c.disposition === "field")
  .map((c) => c.target ?? "");
const unresolved = fieldTargets.filter((t) => !columns.has(t));

describe("Playbook field targets (gate 14)", () => {
  it("reads the generated schema and the column map", () => {
    expect(columns.has("app.access_grid.zone_id")).toBe(true);
    expect(fieldTargets.length).toBeGreaterThan(800);
  });

  it("resolves every Standard Library and Production Template target", () => {
    expect(unresolved.filter((t) => !t.startsWith("app."))).toEqual([]);
  });

  it("holds the unresolved domain targets at the counts in finding A47-001", () => {
    const counts: Record<string, number> = {};
    for (const target of unresolved.filter((t) => t.startsWith("app."))) {
      const table = target.split(".").slice(0, 2).join(".");
      counts[table] = (counts[table] ?? 0) + 1;
    }
    expect(counts).toEqual(UNRESOLVED_APP_TARGETS);
  });
});
