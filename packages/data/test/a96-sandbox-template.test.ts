import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The sandbox template (migration 1530, private.fill_sandbox) is a copy of the demo seed's core, kept in a migration
 * because production carries no demo tenant (ADR 0033 decision 1). This drift check keeps the copy honest: every
 * project, scope node and record title the template writes must still be one the demo seed writes.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");

const template = (() => {
  const migration = read("supabase/migrations/1530_sandbox_orgs.sql");
  const start = migration.indexOf("create or replace function private.fill_sandbox");
  const end = migration.indexOf("comment on function private.fill_sandbox");
  return migration.slice(start, end);
})();
const seed = [
  "0010_demo_identity",
  "0107_projects",
  "0108_schedule_work_show",
  "0230_demo_settings_profiles",
]
  .map((f) => read(`supabase/seeds/${f}.sql`))
  .join("\n");

/** Quoted literals of a statement shape, for example every `'NWS-S01', 'Opening Night Concert'` pair. */
function literals(sql: string, pattern: RegExp): string[] {
  return [...sql.matchAll(pattern)].map((m) => m[1] ?? "");
}

describe("the sandbox template follows the demo seed", () => {
  it("writes only projects, scope nodes and records the demo seed writes", () => {
    const names = [
      ...literals(template, /'(NW[SG]-[A-Z0-9]+)'/g),
      ...literals(template, /'(Northwind [A-Za-z ]+)'/g),
    ].filter((n) => n !== "");
    expect(names.length).toBeGreaterThan(8);
    for (const name of names) expect(seed, name).toContain(`'${name}'`);
  });

  it("copies each record's kind, subtype and title as the seed has them", () => {
    const records = literals(
      template,
      /\(v_project, (?:v_show, )?('[A-Za-z]+', '[A-Za-z -]+', '[^']+')/g,
    );
    expect(records.length).toBeGreaterThanOrEqual(10);
    for (const record of records) expect(seed, record).toContain(record);
  });

  it("keeps the gate 1 evidence and the Miami-Dade jurisdiction", () => {
    for (const criterion of literals(template, /'(G[12]\.[A-Z_]+)'/g))
      expect(seed).toContain(`'${criterion}'`);
    expect(template).toContain("'US-FL-MIAMI-DADE'");
    expect(seed).toContain("'US-FL-MIAMI-DADE'");
  });
});
