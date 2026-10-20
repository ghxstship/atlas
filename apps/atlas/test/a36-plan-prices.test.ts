import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLAN_SEED_MIGRATION, loadPlanRegistry } from "@xos/schemas/plans";
import { describe, expect, it } from "vitest";

/**
 * private.plan_list_prices (created in migration 1060) mirrors the monthly prices of
 * packages/schemas/plans.yaml, the single source of every plan, so wholesale statements are priced in
 * the database. Since pricing v4 (ADR 0035) the generated plan seed writes the mirror, so a price
 * change in plans.yaml reaches the database with the next generated seed. This test keeps the two
 * identical (the ADR 0026 mirrored-source pattern).
 */
const migration = readFileSync(
  fileURLToPath(new URL(`../../../${PLAN_SEED_MIGRATION}`, import.meta.url)),
  "utf8",
);

function mirrored(): Map<string, number | null> {
  const block = migration.slice(migration.indexOf("insert into private.plan_list_prices"));
  const values = block.slice(0, block.indexOf(";"));
  const out = new Map<string, number | null>();
  for (const m of values.matchAll(/\('([a-z_]+)', '([A-Z]{3})', (null|\d+)\)/g)) {
    out.set(`${m[1]}:${m[2]}`, m[3] === "null" ? null : Number(m[3]));
  }
  return out;
}

describe("wholesale list prices", () => {
  it("mirror the monthly prices of plans.yaml exactly", () => {
    const registry = loadPlanRegistry();
    const expected = new Map<string, number | null>();
    for (const plan of registry.plans) {
      for (const [currency, price] of Object.entries(plan.prices)) {
        expected.set(`${plan.code}:${currency}`, price.monthlyMinor);
      }
    }
    expect(mirrored()).toEqual(expected);
  });

  it("are written by the generated plan seed, after the table exists", () => {
    expect(PLAN_SEED_MIGRATION > "supabase/migrations/1060_partner_console.sql").toBe(true);
    expect(migration).toContain(
      "on conflict (plan_code, currency_code) do update set monthly_minor = excluded.monthly_minor;",
    );
  });
});
