import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PLANS_YAML_PATH,
  PLAN_SEED_MIGRATION,
  PRICE_BOOK_CURRENCIES,
  PlanRegistryError,
  loadPlanRegistry,
  parsePlanRegistry,
  renderPlanSeedSql,
} from "../../src/plans/index.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string) => readFileSync(`${repoRoot}${path}`, "utf8");
const reference = read("supabase/migrations/0201_platform_reference.sql");
const yamlText = readFileSync(PLANS_YAML_PATH, "utf8");
const registry = loadPlanRegistry();

function enumValues(sql: string, type: string): string[] {
  const match = new RegExp(`create type ${type.replace(".", "\\.")} as enum \\(([^)]*)\\)`).exec(
    sql,
  );
  if (match?.[1] === undefined) throw new Error(`enum ${type} not found`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1] ?? "");
}

function statement(sql: string, start: string): string {
  const from = sql.indexOf(start);
  if (from < 0) throw new Error(`statement ${start} not found`);
  return sql.slice(from, sql.indexOf(";", from));
}

/** The plan rows 0201 seeds. */
function seededPlans(): [string, number][] {
  return [...statement(reference, "insert into app.plans").matchAll(/\('([a-z_]+)', (\d+)\)/g)].map(
    (m) => [m[1] ?? "", Number(m[2])],
  );
}

/** The limit rows 0201 seeds. */
function seededLimits(): [string, string, number | null][] {
  const body = statement(reference, "insert into private.plan_limits");
  return [...body.matchAll(/\('([a-z_]+)', '([a-z_]+)', (null|\d+)\)/g)].map((m) => [
    m[1] ?? "",
    m[2] ?? "",
    m[3] === "null" ? null : Number(m[3]),
  ]);
}

/** The feature rows 0201 seeds through its union of cross joins. */
function seededFeatures(): string[] {
  const body = statement(reference, "insert into private.plan_features");
  const rows: string[] = [];
  for (const block of body.split("union all")) {
    const lists = [...block.matchAll(/\(values ([^)]*(?:\)[^)]*)*?)\) as ([pf]) /g)];
    const valuesOf = (alias: string) => {
      const found = lists.find((l) => l[2] === alias)?.[1] ?? "";
      return [...found.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? "");
    };
    const single = /select '([a-z_]+)',/.exec(block)?.[1];
    const plans = single === undefined ? valuesOf("p") : [single];
    for (const p of plans) for (const f of valuesOf("f")) rows.push(`${p}:${f}`);
  }
  return rows.sort();
}

describe("plans.yaml", () => {
  it("lists the Postgres enum values in enum order", () => {
    expect([...registry.limits]).toEqual(enumValues(reference, "app.plan_limit_code"));
    expect([...registry.features]).toEqual(enumValues(reference, "app.plan_feature_code"));
  });

  it("states the Section 16 gates", () => {
    const byCode = Object.fromEntries(registry.plans.map((p) => [p.code, p]));
    expect(registry.plans.map((p) => p.code)).toEqual([
      "access",
      "core",
      "pro",
      "team",
      "enterprise",
    ]);
    expect(byCode["access"]?.limits).toEqual({
      seats: 1,
      active_projects: 2,
      field_members: 10,
      active_external_engagements_per_month: 25,
    });
    expect(registry.plans.map((p) => p.limits["active_external_engagements_per_month"])).toEqual([
      25,
      250,
      2500,
      null,
      null,
    ]);
    const marketplace = registry.plans.filter((p) =>
      p.features.includes("public_marketplace_listings"),
    );
    expect(marketplace.map((p) => p.code)).toEqual(["pro", "team", "enterprise"]);
    expect(byCode["enterprise"]?.features).toEqual(registry.features);
  });

  it("prices every plan in USD, EUR, GBP, CAD and AUD, never coercing unpriced to zero", () => {
    for (const plan of registry.plans) {
      expect(Object.keys(plan.prices)).toEqual([...PRICE_BOOK_CURRENCIES]);
      for (const price of Object.values(plan.prices)) {
        if (plan.free) expect(price).toEqual({ monthlyMinor: 0, annualMinor: 0 });
        else {
          expect(price.monthlyMinor).not.toBe(0);
          expect(price.annualMinor).not.toBe(0);
        }
      }
    }
  });
});

describe("generated plan seed migration", () => {
  const sql = renderPlanSeedSql(registry);

  it("matches the generator output for plans.yaml", () => {
    expect(read(PLAN_SEED_MIGRATION)).toBe(sql);
  });

  it("produces exactly the plan, limit and feature rows 0201 seeds", () => {
    expect(registry.plans.map((p) => [p.code, p.sortOrder])).toEqual(seededPlans());
    expect(
      registry.plans.flatMap((p) => registry.limits.map((l) => [p.code, l, p.limits[l]])),
    ).toEqual(seededLimits());
    const generated = registry.plans.flatMap((p) => p.features.map((f) => `${p.code}:${f}`)).sort();
    expect(seededFeatures()).toHaveLength(50);
    expect(generated).toEqual(seededFeatures());
  });

  it("upserts so applying 0201 and 0207 from empty is consistent", () => {
    expect(sql).toContain("on conflict (code) do update set sort_order = excluded.sort_order;");
    expect(sql).toContain(
      "on conflict (plan_code, limit_code) do update set limit_value = excluded.limit_value;",
    );
    expect(sql).toContain("on conflict (plan_code, feature_code) do nothing;");
    expect(sql).toContain("delete from private.plan_features f");
  });

  it("is deterministic", () => {
    expect(renderPlanSeedSql(parsePlanRegistry(yamlText))).toBe(sql);
  });
});

describe("plan registry validation", () => {
  const broken = (from: string, to: string) => {
    expect(yamlText).toContain(from);
    return () => parsePlanRegistry(yamlText.replace(from, to));
  };

  it("rejects malformed text", () => {
    expect(() => parsePlanRegistry("version: 2")).toThrow(PlanRegistryError);
  });

  it.each([
    ["a missing limit", "      seats: 1\n", "", /must state exactly the limits/],
    [
      "an unknown feature",
      "features: [approvals,",
      "features: [teleport, approvals,",
      /unknown feature teleport/,
    ],
    [
      "a repeated feature",
      "features: [custom_roles,",
      "features: [approvals, custom_roles,",
      /repeats feature approvals/,
    ],
    ["a non-zero free price", "USD: { monthly_minor: 0,", "USD: { monthly_minor: 5,", /is free/],
    [
      "a zero paid price",
      "  - code: core\n    extends: access\n    limits:\n      seats: null\n      active_projects: null\n      field_members: null\n      active_external_engagements_per_month: 250\n    features: [approvals, advancing, procurement, upl_export]\n    prices:\n      USD: { monthly_minor: null,",
      "  - code: core\n    extends: access\n    limits:\n      seats: null\n      active_projects: null\n      field_members: null\n      active_external_engagements_per_month: 250\n    features: [approvals, advancing, procurement, upl_export]\n    prices:\n      USD: { monthly_minor: 0,",
      /cannot be 0/,
    ],
    ["a wrong parent", "extends: core", "extends: access", /must extend the plan before it/],
    [
      "a shrinking limit",
      "active_external_engagements_per_month: 2500",
      "active_external_engagements_per_month: 20",
      /fewer/,
    ],
    [
      "a duplicate limit code",
      "  - field_members\n",
      "  - field_members\n  - seats\n",
      /listed twice/,
    ],
    [
      "a missing currency",
      "currencies: [USD, EUR, GBP, CAD, AUD]",
      "currencies: [USD, EUR]",
      /currencies must be/,
    ],
  ])("rejects %s", (_label, from, to, message) => {
    expect(broken(from, to)).toThrow(message);
  });

  it("rejects a first plan that extends or is not free", () => {
    expect(
      broken("  - code: access\n    free: true\n", "  - code: access\n    extends: core\n"),
    ).toThrow(/first plan/);
  });

  it("rejects a limit on a plan above an unlimited one", () => {
    expect(
      broken(
        "      active_external_engagements_per_month: null\n    features: [custom_roles",
        "      active_external_engagements_per_month: 9\n    features: [custom_roles",
      ),
    ).toThrow(/fewer|although/);
  });

  it("rejects a plan that misses a currency", () => {
    expect(broken("      AUD: { monthly_minor: 0, annual_minor: 0 }\n", "")).toThrow(
      /price every currency/,
    );
  });
});
