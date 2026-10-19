import { describe, expect, it } from "vitest";
import { loadPlanRegistry } from "@xos/schemas/plans";
import {
  CatalogDriftError,
  assertTestModeKey,
  stripeCatalog,
  syncStripeCatalog,
  type StripeCatalogClient,
} from "../src/billing/stripe-setup.ts";

const registry = loadPlanRegistry();

type Row = Record<string, unknown>;

/**
 * A mocked Stripe account held in memory: it answers the catalogue calls the setup makes, records
 * every write, and 404s like Stripe for a missing product or coupon. It never reaches the network.
 */
function mockStripe() {
  const products = new Map<string, Row>();
  const prices: Row[] = [];
  const coupons = new Map<string, Row>();
  const promotionCodes: Row[] = [];
  const writes: string[] = [];
  const missing = () => Object.assign(new Error("No such object"), { statusCode: 404 });
  const client = {
    products: {
      retrieve: async (id: string) => {
        const found = products.get(id);
        if (found === undefined) throw missing();
        return found;
      },
      create: async (params: Row) => {
        writes.push(`products.create ${String(params["id"])}`);
        const row = { ...params, active: true, object: "product" };
        products.set(String(params["id"]), row);
        return row;
      },
      update: async (id: string, params: Row) => {
        writes.push(`products.update ${id}`);
        const row = { ...products.get(id), ...params };
        products.set(id, row);
        return row;
      },
    },
    prices: {
      list: async (params: { lookup_keys: string[] }) => ({
        data: prices.filter((p) => p["lookup_key"] === params.lookup_keys[0]),
      }),
      create: async (params: Row) => {
        writes.push(`prices.create ${String(params["lookup_key"])}`);
        const recurring = params["recurring"] as { interval: string } | undefined;
        const row = {
          ...params,
          id: `price_${String(prices.length + 1)}`,
          active: true,
          recurring: recurring === undefined ? null : { ...recurring, interval_count: 1 },
        };
        prices.push(row);
        return row;
      },
    },
    coupons: {
      retrieve: async (id: string) => {
        const found = coupons.get(id);
        if (found === undefined) throw missing();
        return found;
      },
      create: async (params: Row) => {
        writes.push(`coupons.create ${String(params["id"])}`);
        coupons.set(String(params["id"]), params);
        return params;
      },
    },
    promotionCodes: {
      list: async (params: { code: string }) => ({
        data: promotionCodes.filter((p) => p["code"] === params.code),
      }),
      create: async (params: Row) => {
        writes.push(`promotionCodes.create ${String(params["code"])}`);
        promotionCodes.push(params);
        return params;
      },
    },
  };
  return {
    client: client as unknown as StripeCatalogClient,
    products,
    prices,
    coupons,
    promotionCodes,
    writes,
  };
}

describe("Stripe catalogue from plans.yaml", () => {
  const catalog = stripeCatalog(registry);

  it("has one product per self-serve plan, the extra-seat product and the Aurora pack", () => {
    expect(catalog.products.map((p) => p.id)).toEqual([
      "xos_plan_core_v4",
      "xos_plan_pro_v4",
      "xos_plan_team_v4",
      "xos_extra_seat_v4",
      "xos_addon_aurora_requests_1000_v4",
    ]);
    expect(catalog.products.every((p) => p.metadata["lookup_key"] === p.id)).toBe(true);
  });

  it("prices every plan and seat monthly and yearly, and the pack once, in every currency", () => {
    expect(catalog.prices).toHaveLength(13);
    const pro = catalog.prices.find((p) => p.lookupKey === "xos_plan_pro_annual_v4");
    expect(pro).toMatchObject({
      productId: "xos_plan_pro_v4",
      currency: "usd",
      unitAmount: 399000,
      interval: "year",
      currencyOptions: { eur: 369000, gbp: 319000, cad: 549000, aud: 609000 },
    });
    const seat = catalog.prices.find((p) => p.lookupKey === "xos_seat_team_monthly_v4");
    expect(seat).toMatchObject({
      productId: "xos_extra_seat_v4",
      unitAmount: 1500,
      interval: "month",
      currencyOptions: { eur: 1400, gbp: 1200, cad: 2100, aud: 2300 },
    });
    const pack = catalog.prices.find(
      (p) => p.lookupKey === "xos_addon_aurora_requests_1000_once_v4",
    );
    expect(pack).toMatchObject({
      interval: null,
      unitAmount: 4900,
      currencyOptions: { eur: 4500, gbp: 3900, cad: 6700, aud: 7500 },
    });
    expect(catalog.prices.some((p) => p.lookupKey.includes("enterprise"))).toBe(false);
  });

  it("limits the founding coupon to 50 redemptions over 12 months on plans and seats", () => {
    expect(catalog.coupons).toEqual([
      {
        id: "xos_founding_customer_v4",
        name: "30% off for 12 months",
        percentOff: 30,
        durationMonths: 12,
        maxRedemptions: 50,
        productIds: [
          "xos_plan_core_v4",
          "xos_plan_pro_v4",
          "xos_plan_team_v4",
          "xos_extra_seat_v4",
        ],
        metadata: { xos_offer: "founding_customer" },
      },
    ]);
    expect(catalog.promotionCodes).toEqual([
      {
        code: "FOUNDING30",
        couponId: "xos_founding_customer_v4",
        maxRedemptions: 50,
        metadata: { xos_offer: "founding_customer" },
      },
    ]);
  });

  it("refuses a price book without USD, which Stripe needs as the default currency", () => {
    const broken = {
      ...registry,
      addons: registry.addons.map((a) => ({
        ...a,
        prices: { ...a.prices, USD: null as unknown as number },
      })),
    };
    expect(() => stripeCatalog(broken)).toThrow(/no USD price/);
  });
});

describe("Stripe catalogue setup against a mocked Stripe client", () => {
  it("creates everything on an empty account, in test mode prices with currency options", async () => {
    const stripe = mockStripe();
    const report = await syncStripeCatalog(stripe.client, registry);
    expect(report.items.every((i) => i.action === "created")).toBe(true);
    expect(stripe.products.size).toBe(5);
    expect(stripe.prices).toHaveLength(13);
    const core = stripe.prices.find((p) => p["lookup_key"] === "xos_plan_core_monthly_v4");
    expect(core).toMatchObject({
      product: "xos_plan_core_v4",
      currency: "usd",
      unit_amount: 14900,
      tax_behavior: "exclusive",
      recurring: { interval: "month" },
      currency_options: { eur: { unit_amount: 13900, tax_behavior: "exclusive" } },
    });
    const pack = stripe.prices.find(
      (p) => p["lookup_key"] === "xos_addon_aurora_requests_1000_once_v4",
    );
    expect(pack?.["recurring"]).toBeNull();
    expect(stripe.coupons.get("xos_founding_customer_v4")).toMatchObject({
      percent_off: 30,
      duration: "repeating",
      duration_in_months: 12,
      max_redemptions: 50,
    });
    expect(stripe.promotionCodes[0]).toMatchObject({
      code: "FOUNDING30",
      promotion: { type: "coupon", coupon: "xos_founding_customer_v4" },
      max_redemptions: 50,
      restrictions: { first_time_transaction: true },
    });
  });

  it("is idempotent: a second run writes nothing", async () => {
    const stripe = mockStripe();
    await syncStripeCatalog(stripe.client, registry);
    // Stripe returns the promotion's coupon on the promotion code object.
    for (const code of stripe.promotionCodes)
      code["promotion"] = { coupon: "xos_founding_customer_v4" };
    const count = stripe.writes.length;
    const again = await syncStripeCatalog(stripe.client, registry);
    expect(again.items.every((i) => i.action === "unchanged")).toBe(true);
    expect(stripe.writes).toHaveLength(count);
  });

  it("writes nothing on a dry run", async () => {
    const stripe = mockStripe();
    const report = await syncStripeCatalog(stripe.client, registry, { dryRun: true });
    expect(report.items.every((i) => i.action === "would create")).toBe(true);
    expect(stripe.writes).toEqual([]);
  });

  it("brings a renamed or archived product back in place", async () => {
    const stripe = mockStripe();
    await syncStripeCatalog(stripe.client, registry);
    for (const code of stripe.promotionCodes)
      code["promotion"] = { coupon: "xos_founding_customer_v4" };
    stripe.products.set("xos_plan_pro_v4", {
      ...stripe.products.get("xos_plan_pro_v4"),
      name: "Old name",
      active: false,
    });
    const dry = await syncStripeCatalog(stripe.client, registry, { dryRun: true });
    expect(dry.items.find((i) => i.key === "xos_plan_pro_v4")?.action).toBe("would update");
    const report = await syncStripeCatalog(stripe.client, registry);
    expect(report.items.find((i) => i.key === "xos_plan_pro_v4")?.action).toBe("updated");
    expect(stripe.products.get("xos_plan_pro_v4")).toMatchObject({ name: "XOS Pro", active: true });
  });

  it("stops before writing when a price, coupon or promotion code differs from plans.yaml", async () => {
    const stripe = mockStripe();
    await syncStripeCatalog(stripe.client, registry);
    const core = stripe.prices.find((p) => p["lookup_key"] === "xos_plan_core_monthly_v4");
    if (core === undefined) throw new Error("core price missing");
    core["unit_amount"] = 4900;
    core["currency_options"] = { eur: { unit_amount: 1 } };
    core["active"] = false;
    core["recurring"] = { interval: "year", interval_count: 1 };
    core["product"] = { id: "atlvs_plan_core_v3" };
    core["currency"] = "eur";
    stripe.coupons.set("xos_founding_customer_v4", {
      percent_off: 20,
      duration: "once",
      duration_in_months: null,
      max_redemptions: 100,
    });
    stripe.promotionCodes[0] = { code: "FOUNDING30", promotion: { coupon: "other" } };
    stripe.products.delete("xos_plan_team_v4");
    const count = stripe.writes.length;
    const run = syncStripeCatalog(stripe.client, registry);
    await expect(run).rejects.toBeInstanceOf(CatalogDriftError);
    const error = (await run.catch((e: unknown) => e)) as CatalogDriftError;
    expect(error.differences).toEqual([
      "price xos_plan_core_monthly_v4 is archived in Stripe",
      "price xos_plan_core_monthly_v4 belongs to atlvs_plan_core_v3, not xos_plan_core_v4",
      "price xos_plan_core_monthly_v4 is in eur, not usd",
      "price xos_plan_core_monthly_v4 costs 4900, not 14900",
      "price xos_plan_core_monthly_v4 recurs year, not month",
      "price xos_plan_core_monthly_v4 costs 1 in eur, not 13900",
      "price xos_plan_core_monthly_v4 costs nothing in gbp, not 11900",
      "price xos_plan_core_monthly_v4 costs nothing in cad, not 19900",
      "price xos_plan_core_monthly_v4 costs nothing in aud, not 22900",
      "coupon xos_founding_customer_v4 takes 20% off, not 30%",
      "coupon xos_founding_customer_v4 lasts once, not 12 months",
      "coupon xos_founding_customer_v4 allows 100 redemptions, not 50",
      "promotion code FOUNDING30 applies other, not xos_founding_customer_v4",
    ]);
    expect(stripe.writes).toHaveLength(count);
  });

  it("passes on errors other than a missing object", async () => {
    const stripe = mockStripe();
    const failing = {
      ...stripe.client,
      products: {
        ...stripe.client.products,
        retrieve: async () => {
          throw Object.assign(new Error("Invalid API key"), { statusCode: 401 });
        },
      },
    } as StripeCatalogClient;
    await expect(syncStripeCatalog(failing, registry)).rejects.toThrow(/Invalid API key/);
    const failingCoupons = {
      ...stripe.client,
      coupons: {
        ...stripe.client.coupons,
        retrieve: async () => {
          throw Object.assign(new Error("Rate limited"), { statusCode: 429 });
        },
      },
    } as StripeCatalogClient;
    await expect(syncStripeCatalog(failingCoupons, registry)).rejects.toThrow(/Rate limited/);
  });
});

describe("test mode key", () => {
  it("accepts only Stripe test mode secret or restricted keys", () => {
    expect(assertTestModeKey("sk_test_abcdefgh123")).toBe("sk_test_abcdefgh123");
    expect(assertTestModeKey("rk_test_abcdefgh123")).toBe("rk_test_abcdefgh123");
    expect(() => assertTestModeKey(undefined)).toThrow(/not set/);
    expect(() => assertTestModeKey("")).toThrow(/not set/);
    expect(() => assertTestModeKey("sk_live_abcdefgh123")).toThrow(/not a Stripe test mode key/);
    expect(() => assertTestModeKey("pk_test_abcdefgh123")).toThrow(/not a Stripe test mode key/);
  });
});
