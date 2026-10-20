import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readColumnMap } from "../src/playbook/column-map.ts";
import { exposedFields, schemaColumns } from "../src/playbook/targets.ts";
import type { OpenApiDocument } from "../src/playbook/targets.ts";

/**
 * Section 18 gate 14, the OpenAPI half: every Playbook `field` target exists in the OpenAPI document. A target
 * `schema.table.column` is exposed when an operation tagged `x-xos-table: schema.table` returns a row field named
 * `column` (packages/api/openapi/v1.json). The schema half is canon/import/test/field-targets.test.ts; a target that
 * names no column is left to it.
 *
 * Otherwise the column map entry says how the target reaches the API in its `api` key:
 * - "Exposed as schema.table.field": a resource returns it under another name or through another relation (for
 *   example `xpms.rate_card` through the resolved rate cards, `due_at` for `scheduled_ends_at`);
 * - "Not exposed: <reason>": deliberately kept out, because it is Restricted, internal, or the template store.
 *
 * What is left has no API field yet. NOT_YET_EXPOSED held those per table (finding legal/qa/findings/A54-002.md);
 * A63 exposed the last 56, so it is empty and stays empty: a new field target needs its API field, or its reason,
 * in the same change.
 */
const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

const NOT_YET_EXPOSED: Readonly<Record<string, number>> = {};

const EXPOSED_AS = "Exposed as ";
const NOT_EXPOSED = "Not exposed: ";

const doc = JSON.parse(
  readFileSync(repo("packages/api/openapi/v1.json"), "utf8"),
) as OpenApiDocument;
const exposed = exposedFields(doc);
const columns = schemaColumns(readFileSync(repo("packages/data/src/database.types.ts"), "utf8"));
const sheets = readColumnMap(readFileSync(repo("canon/map/playbook-columns.yaml"), "utf8")).sheets;
const fields = sheets.flatMap((s) =>
  s.columns
    .filter((c) => c.disposition === "field" && columns.has(c.target ?? ""))
    .map((c) => ({ sheet: s, column: c, target: c.target as string })),
);
type Field = (typeof fields)[number];
const where = (f: Field) => `${f.sheet.sheet} ${f.column.letter} (${f.target})`;
const tableOf = (target: string) => target.split(".").slice(0, 2).join(".");
const fieldOf = (target: string) => target.split(".")[2] as string;
const returns = (target: string) => exposed.get(tableOf(target))?.has(fieldOf(target)) ?? false;

const direct = fields.filter((f) => returns(f.target));
const renamed = fields.filter((f) => f.column.api?.startsWith(EXPOSED_AS));
const kept = fields.filter((f) => f.column.api?.startsWith(NOT_EXPOSED));
const missing = fields.filter((f) => !returns(f.target) && f.column.api === undefined);

describe("Playbook field targets in the OpenAPI document (gate 14)", () => {
  it("reads the document and the resolved field targets", () => {
    expect(exposed.get("app.projects")?.has("project_key")).toBe(true);
    expect(fields.length).toBeGreaterThan(780);
  });

  it("finds each target on a resource of its table, under another name, or with a reason it stays out", () => {
    expect(direct.length + renamed.length + kept.length + missing.length).toBe(fields.length);
    expect(direct.length).toBeGreaterThan(500);
  });

  it("names a real resource field for every target exposed under another name", () => {
    const wrong = renamed.filter(
      (f) => !returns((f.column.api as string).slice(EXPOSED_AS.length)),
    );
    expect(wrong.map(where)).toEqual([]);
  });

  it("gives every deliberately unexposed target its reason", () => {
    expect(
      kept.filter((f) => (f.column.api as string).length < NOT_EXPOSED.length + 20).map(where),
    ).toEqual([]);
  });

  it("marks only targets that no resource of their table returns", () => {
    expect(
      fields.filter((f) => f.column.api !== undefined && returns(f.target)).map(where),
    ).toEqual([]);
  });

  it("leaves unexposed only the targets in the ledger (finding A54-002)", () => {
    const counts: Record<string, number> = {};
    for (const f of missing) counts[tableOf(f.target)] = (counts[tableOf(f.target)] ?? 0) + 1;
    expect(counts).toEqual(NOT_YET_EXPOSED);
    expect(existsSync(repo("legal/qa/findings/A54-002.md"))).toBe(true);
  });
});
