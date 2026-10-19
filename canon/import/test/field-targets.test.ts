import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readColumnMap } from "../src/playbook/column-map.ts";
import { schemaColumns } from "../src/playbook/targets.ts";

/**
 * Section 18 gate 14: every `field` target in the Playbook column map exists in the schema. The schema is read
 * from the generated database types (`packages/data/src/database.types.ts`, regenerated from the migrations and
 * diffed in CI), so this runs without a database.
 *
 * Standard Library and Production Template targets (`xpms.*`) are generated from the map and must all resolve.
 * The `app.*` targets were written as `<entity>.<column key>` skeletons before the domain schema existed (finding
 * legal/qa/findings/A47-001.md). A51 reconciled them: each now names its real column (in the row's table or one
 * reached through a foreign key, the path stated in its transform), a column migration 1180 added, or the
 * template's own value store with a "Template only:" reason. The 18 that waited on an owner ruling were settled
 * by owner decision 25 (canon/rulings/decision-25.yaml), so OWNER_BLOCKED is empty and must stay so.
 */
const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

// Owner decision 25 (2026-10-19) settled the 18 targets that waited on it (finding A47-001, now Fixed); the
// count holds at zero, so a new unresolved domain target fails until it is reconciled.
const OWNER_BLOCKED: Readonly<Record<string, number>> = {};

const TEMPLATE_VALUES = "xpms.production_template_values.value_text";
const OWNER_PREFIX = "Blocked on owner (RRR-64): ";
const TEMPLATE_PREFIX = "Template only: ";

const columns = schemaColumns(readFileSync(repo("packages/data/src/database.types.ts"), "utf8"));
const sheets = readColumnMap(readFileSync(repo("canon/map/playbook-columns.yaml"), "utf8")).sheets;
const fields = sheets.flatMap((s) =>
  s.columns.filter((c) => c.disposition === "field").map((c) => ({ sheet: s, column: c })),
);
const fieldTargets = fields.map((f) => f.column.target ?? "");
const unresolved = fields.filter((f) => !columns.has(f.column.target ?? ""));
const where = (f: (typeof fields)[number]) => `${f.sheet.sheet} ${f.column.letter}`;

describe("Playbook field targets (gate 14)", () => {
  it("reads the generated schema and the column map", () => {
    expect(columns.has("app.access_grid.zone_id")).toBe(true);
    expect(fieldTargets.length).toBeGreaterThan(800);
  });

  it("resolves every Standard Library and Production Template target", () => {
    expect(unresolved.map((f) => f.column.target).filter((t) => !t?.startsWith("app."))).toEqual(
      [],
    );
  });

  it("leaves unresolved only the domain targets blocked on an owner ruling (finding A47-001)", () => {
    const counts: Record<string, number> = {};
    for (const f of unresolved) {
      const table = (f.column.target ?? "").split(".").slice(0, 2).join(".");
      counts[table] = (counts[table] ?? 0) + 1;
    }
    expect(counts).toEqual(OWNER_BLOCKED);
    expect(
      unresolved.filter((f) => !f.column.transform?.startsWith(OWNER_PREFIX)).map(where),
    ).toEqual([]);
  });

  it("marks owner-blocked only what is still unresolved", () => {
    const marked = fields.filter((f) => f.column.transform?.startsWith(OWNER_PREFIX));
    expect(marked.filter((f) => columns.has(f.column.target ?? "")).map(where)).toEqual([]);
  });

  it("gives every template-only Production Template column its reason", () => {
    const templateOnly = fields.filter(
      (f) => f.sheet.destination === "production-template" && f.column.target === TEMPLATE_VALUES,
    );
    expect(templateOnly.length).toBeGreaterThan(0);
    expect(
      templateOnly
        .filter(
          (f) =>
            (f.column.transform ?? "").length <= TEMPLATE_PREFIX.length + 10 ||
            !f.column.transform?.startsWith(TEMPLATE_PREFIX),
        )
        .map(where),
    ).toEqual([]);
  });
});
