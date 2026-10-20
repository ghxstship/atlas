import { readFileSync, readdirSync } from "node:fs";
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

const migrations = readdirSync(`${repoRoot}supabase/migrations`)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => read(`supabase/migrations/${f}`));

/** Enum values in enum order: the create type in 0201, then every later add value, in migration order. */
function enumValues(type: string): string[] {
  const escaped = type.replace(".", "\\.");
  const match = new RegExp(`create type ${escaped} as enum \\(([^)]*)\\)`).exec(reference);
  if (match?.[1] === undefined) throw new Error(`enum ${type} not found`);
  const values = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1] ?? "");
  const added = new RegExp(`alter type ${escaped} add value (?:if not exists )?'([^']+)'`, "g");
  for (const sql of migrations) for (const m of sql.matchAll(added)) values.push(m[1] ?? "");
  return values;
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
    expect([...registry.limits]).toEqual(enumValues("app.plan_limit_code"));
    expect([...registry.features]).toEqual(enumValues("app.plan_feature_code"));
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
    // Section 16 allowed 2 active projects on Access; the owner set the first project free (ADR 0018).
    expect(byCode["access"]?.limits).toEqual({
      seats: 1,
      active_projects: 1,
      field_members: 10,
      active_external_engagements_per_month: 25,
      aurora_requests_per_month: 0,
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

  it("packages Aurora and Legend by tier (ADR 0020)", () => {
    const withFeature = (f: string) =>
      registry.plans.filter((p) => p.features.includes(f)).map((p) => p.code);
    expect(withFeature("aurora_ai")).toEqual(["core", "pro", "team", "enterprise"]);
    expect(withFeature("legend_early_access")).toEqual(["enterprise"]);
    expect(registry.plans.map((p) => p.limits["aurora_requests_per_month"])).toEqual([
      0,
      500,
      2000,
      10000,
      null,
    ]);
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

  it("keeps 0201's plans and differs from its limits and features only where ADR 0018, ADR 0020 and ADR 0035 say", () => {
    expect(registry.plans.map((p) => [p.code, p.sortOrder])).toEqual(seededPlans());
    const generatedLimits = registry.plans.flatMap((p) =>
      registry.limits.map((l) => [p.code, l, p.limits[l]] as [string, string, number | null]),
    );
    const changed = generatedLimits.filter(
      ([plan, limit, value]) =>
        seededLimits().find(([p, l]) => p === plan && l === limit)?.[2] !== value,
    );
    expect(changed).toEqual([
      ["access", "active_projects", 1],
      ["access", "aurora_requests_per_month", 0],
      ["core", "seats", 5],
      ["core", "aurora_requests_per_month", 500],
      ["pro", "seats", 15],
      ["pro", "aurora_requests_per_month", 2000],
      ["team", "seats", 40],
      ["team", "aurora_requests_per_month", 10000],
      ["enterprise", "aurora_requests_per_month", null],
    ]);
    const generated = registry.plans.flatMap((p) => p.features.map((f) => `${p.code}:${f}`)).sort();
    expect(seededFeatures()).toHaveLength(50);
    const added = [
      "core:aurora_ai",
      "enterprise:aurora_ai",
      "enterprise:legend_early_access",
      "pro:aurora_ai",
      "team:aurora_ai",
    ];
    expect(generated).toEqual([...seededFeatures(), ...added].sort());
  });

  it("upserts, so applying 0201 and every plan seed in order ends in the registry state", () => {
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
      "      USD: { monthly_minor: 14900, annual_minor: 149000 }",
      "      USD: { monthly_minor: 0, annual_minor: 0 }",
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
        "      active_external_engagements_per_month: null\n      aurora_requests_per_month: null\n",
        "      active_external_engagements_per_month: 9\n      aurora_requests_per_month: null\n",
      ),
    ).toThrow(/fewer|although/);
  });

  it("rejects a plan that misses a currency", () => {
    expect(broken("      AUD: { monthly_minor: 0, annual_minor: 0 }\n", "")).toThrow(
      /price every currency/,
    );
  });

  const coreStripe =
    "    stripe:\n      product_lookup_key: xos_plan_core_v4\n      prices:\n        monthly: xos_plan_core_monthly_v4\n        annual: xos_plan_core_annual_v4\n";

  it("rejects a paid plan without Stripe lookup keys", () => {
    expect(broken(coreStripe, "")).toThrow(/must name its Stripe product/);
  });

  it("rejects Stripe lookup keys on the free plan", () => {
    expect(
      broken(
        "    features: []\n",
        "    features: []\n    stripe:\n      product_lookup_key: xos_plan_access_v4\n      prices:\n        monthly: access_monthly\n        annual: access_annual\n",
      ),
    ).toThrow(/is free, so it has no Stripe price/);
  });

  it("rejects a Stripe lookup key used twice", () => {
    expect(broken("annual: xos_plan_core_annual_v4", "annual: xos_plan_core_monthly_v4")).toThrow(
      /used twice/,
    );
  });
});

describe("pricing v4 (ADR 0035)", () => {
  const byCode = Object.fromEntries(registry.plans.map((p) => [p.code, p]));

  it("names the v4 Stripe product and prices of every self-serve plan", () => {
    for (const plan of registry.plans) {
      if (!plan.selfServe) {
        expect(plan.stripe).toBeNull();
        continue;
      }
      expect(plan.stripe).toEqual({
        productLookupKey: `xos_plan_${plan.code}_v4`,
        monthlyPriceLookupKey: `xos_plan_${plan.code}_monthly_v4`,
        annualPriceLookupKey: `xos_plan_${plan.code}_annual_v4`,
      });
      expect(plan.extraSeat?.monthlyPriceLookupKey).toBe(`xos_seat_${plan.code}_monthly_v4`);
      expect(plan.extraSeat?.annualPriceLookupKey).toBe(`xos_seat_${plan.code}_annual_v4`);
    }
    expect(registry.plans.filter((p) => p.selfServe).map((p) => p.code)).toEqual([
      "core",
      "pro",
      "team",
    ]);
    expect(registry.extraSeatProductLookupKey).toBe("xos_extra_seat_v4");
  });

  it("carries the approved prices, annual at ten times monthly", () => {
    const monthly = (currency: "USD" | "EUR" | "GBP" | "CAD" | "AUD") =>
      registry.plans.map((p) => p.prices[currency].monthlyMinor);
    expect(monthly("USD")).toEqual([0, 14900, 39900, 89900, null]);
    expect(monthly("EUR")).toEqual([0, 13900, 36900, 82900, null]);
    expect(monthly("GBP")).toEqual([0, 11900, 31900, 71900, null]);
    expect(monthly("CAD")).toEqual([0, 19900, 54900, 122900, null]);
    expect(monthly("AUD")).toEqual([0, 22900, 60900, 136900, null]);
    expect(registry.annualMultiplier).toBe(10);
    for (const plan of registry.plans) {
      for (const price of Object.values(plan.prices)) {
        if (price.monthlyMinor !== null) expect(price.annualMinor).toBe(price.monthlyMinor * 10);
      }
    }
  });

  it("sells seats: an allowance per plan, extra seats above it, unlimited field crew on paid plans", () => {
    expect(registry.plans.map((p) => p.limits["seats"])).toEqual([1, 5, 15, 40, null]);
    for (const plan of registry.plans.filter((p) => !p.free)) {
      expect(plan.limits["field_members"]).toBeNull();
      expect(plan.limits["active_projects"]).toBeNull();
    }
    const seat = (code: string) =>
      Object.values(byCode[code]?.extraSeat?.prices ?? {}).map((p) => p.monthlyMinor);
    expect(seat("core")).toEqual([1900, 1800, 1500, 2600, 2900]);
    expect(seat("pro")).toEqual([1900, 1800, 1500, 2600, 2900]);
    expect(seat("team")).toEqual([1500, 1400, 1200, 2100, 2300]);
    expect(byCode["access"]?.extraSeat).toBeNull();
    expect(byCode["enterprise"]?.extraSeat).toBeNull();
  });

  it("quotes Enterprise from 2,500 dollars a month on an annual contract, never self-serve", () => {
    expect(byCode["enterprise"]?.selfServe).toBe(false);
    expect(byCode["enterprise"]?.quote).toEqual({
      contract: "annual",
      fromMonthlyMinor: { USD: 250000, EUR: null, GBP: null, CAD: null, AUD: null },
    });
  });

  it("sells 1,000 Aurora requests as a one-time pack in every currency", () => {
    expect(registry.addons).toEqual([
      {
        code: "aurora_requests_1000",
        limit: "aurora_requests_per_month",
        amount: 1000,
        plans: ["core", "pro", "team"],
        prices: { USD: 4900, EUR: 4500, GBP: 3900, CAD: 6700, AUD: 7500 },
        productLookupKey: "xos_addon_aurora_requests_1000_v4",
        priceLookupKey: "xos_addon_aurora_requests_1000_once_v4",
      },
    ]);
  });

  it("offers founding customers 30 percent off the first year, 50 redemptions, and partners 30 percent", () => {
    expect(registry.offers).toEqual([
      {
        code: "founding_customer",
        percentOff: 30,
        durationMonths: 12,
        maxRedemptions: 50,
        plans: ["core", "pro", "team"],
        couponId: "xos_founding_customer_v4",
        promotionCode: "FOUNDING30",
      },
    ]);
    expect(registry.partnerWholesaleDiscountBps).toBe(3000);
  });
});

describe("pricing v4 validation", () => {
  const broken = (from: string, to: string) => {
    expect(yamlText).toContain(from);
    return () => parsePlanRegistry(yamlText.replace(from, to));
  };
  const enterprisePrices = [
    "    prices:",
    "      USD: { monthly_minor: null, annual_minor: null }",
    "      EUR: { monthly_minor: null, annual_minor: null }",
    "      GBP: { monthly_minor: null, annual_minor: null }",
    "      CAD: { monthly_minor: null, annual_minor: null }",
    "      AUD: { monthly_minor: null, annual_minor: null }",
    "    quote:",
  ].join("\n");

  it.each([
    [
      "an annual price off the multiplier",
      "USD: { monthly_minor: 39900, annual_minor: 399000 }",
      "USD: { monthly_minor: 39900, annual_minor: 400000 }",
      /annually at 10 times monthly/,
    ],
    [
      "a monthly price without its annual price",
      "USD: { monthly_minor: 39900, annual_minor: 399000 }",
      "USD: { monthly_minor: 39900, annual_minor: null }",
      /monthly and annual together/,
    ],
    [
      "a zero extra-seat price",
      "USD: { monthly_minor: 1500, annual_minor: 15000 }",
      "USD: { monthly_minor: 0, annual_minor: 0 }",
      /extra seat is not free/,
    ],
    [
      "a quoted plan with a list price",
      enterprisePrices,
      enterprisePrices.replace(
        "USD: { monthly_minor: null, annual_minor: null }",
        "USD: { monthly_minor: 9, annual_minor: 90 }",
      ),
      /sold by quote, so its list prices stay null/,
    ],
    [
      "a quote that misses a currency",
      "from_monthly_minor: { USD: 250000, EUR: null, GBP: null, CAD: null, AUD: null }",
      "from_monthly_minor: { USD: 250000 }",
      /quote from-price for every currency/,
    ],
    [
      "a quote from zero",
      "from_monthly_minor: { USD: 250000,",
      "from_monthly_minor: { USD: 0,",
      /cannot quote from 0/,
    ],
    [
      "an add-on for a plan sold by quote",
      "plans: [core, pro, team]\n    prices: { USD: 4900,",
      "plans: [core, pro, team, enterprise]\n    prices: { USD: 4900,",
      /only to self-serve paid plans, not enterprise/,
    ],
    [
      "an add-on for an unknown plan",
      "plans: [core, pro, team]\n    prices: { USD: 4900,",
      "plans: [core, gold]\n    prices: { USD: 4900,",
      /names unknown plan gold/,
    ],
    [
      "an add-on for an unknown limit",
      "adds: { limit: aurora_requests_per_month,",
      "adds: { limit: sms_per_month,",
      /unknown limit sms_per_month/,
    ],
    [
      "an add-on without every currency",
      "prices: { USD: 4900, EUR: 4500, GBP: 3900, CAD: 6700, AUD: 7500 }",
      "prices: { USD: 4900 }",
      /add-on aurora_requests_1000 must price every currency/,
    ],
    [
      "an offer on the free plan",
      "    plans: [core, pro, team]\n    stripe:\n      coupon_id",
      "    plans: [access]\n    stripe:\n      coupon_id",
      /applies only to self-serve paid plans, not access/,
    ],
    [
      "an offer on an unknown plan",
      "    plans: [core, pro, team]\n    stripe:\n      coupon_id",
      "    plans: [gold]\n    stripe:\n      coupon_id",
      /offer founding_customer names unknown plan gold/,
    ],
    [
      "a seat price lookup key reused for a plan price",
      "annual: xos_seat_team_annual_v4",
      "annual: xos_plan_team_annual_v4",
      /used twice/,
    ],
  ])("rejects %s", (_label, from, to, message) => {
    expect(broken(from, to)).toThrow(message);
  });

  it("rejects an add-on that raises a limit the plan leaves unlimited", () => {
    expect(
      broken("adds: { limit: aurora_requests_per_month,", "adds: { limit: active_projects,"),
    ).toThrow(/cannot raise active_projects on core, which is unlimited/);
  });

  it("rejects extra seats on a plan with unlimited seats", () => {
    const seat = [
      "    extra_seat:",
      "      prices:",
      ...["USD", "EUR", "GBP", "CAD", "AUD"].map(
        (c) => `        ${c}: { monthly_minor: 1, annual_minor: 10 }`,
      ),
      "      stripe:",
      "        monthly: e_m",
      "        annual: e_a",
      "    quote:",
    ].join("\n");
    expect(broken("    quote:", seat)).toThrow(/unlimited seats, so it sells no extra seats/);
  });

  it("rejects a seat-limited paid plan that sells no extra seats", () => {
    const start = yamlText.indexOf("    extra_seat:\n", yamlText.indexOf("- code: pro"));
    const end = yamlText.indexOf("\n    stripe:\n", start) + 1;
    expect(() => parsePlanRegistry(yamlText.slice(0, start) + yamlText.slice(end))).toThrow(
      /plan pro limits seats, so it must sell extra seats/,
    );
  });

  it("rejects Stripe prices on a quoted plan", () => {
    expect(
      broken(
        "    quote:",
        "    stripe:\n      product_lookup_key: xos_plan_enterprise_v4\n      prices:\n        monthly: e_m\n        annual: e_a\n    quote:",
      ),
    ).toThrow(/sold by quote, so it has no Stripe price/);
  });

  it("rejects a coupon or promotion code used twice", () => {
    const offer = yamlText.slice(yamlText.indexOf("  - code: founding_customer"));
    expect(() =>
      parsePlanRegistry(yamlText + offer.replace("founding_customer\n", "again\n")),
    ).toThrow(/coupon xos_founding_customer_v4 is used twice[\s\S]*promotion code FOUNDING30/);
  });
});

describe("generated plan seed mirrors", () => {
  const sql = renderPlanSeedSql(registry);

  it("writes list prices, extra-seat prices, add-ons and the partner discount from plans.yaml", () => {
    expect(sql).toContain("insert into private.plan_list_prices");
    expect(sql).toContain("('team', 'USD', 1500, 15000)");
    expect(sql).toContain(
      "('aurora_requests_1000', 'core', 'aurora_requests_per_month'::app.plan_limit_code, 1000)",
    );
    expect(sql).toContain("alter column wholesale_discount_bps set default 3000;");
  });

  it("empties a mirror whose set is empty instead of writing an empty insert", () => {
    const bare = renderPlanSeedSql({
      ...registry,
      addons: [],
      plans: registry.plans.map((p) => ({ ...p, extraSeat: null })),
    });
    expect(bare).not.toContain("insert into private.plan_addons");
    expect(bare).not.toContain("insert into private.plan_extra_seat_prices");
    expect(bare).toContain("delete from private.plan_addons;");
    expect(bare).toContain("delete from private.plan_extra_seat_prices;");
  });
});
