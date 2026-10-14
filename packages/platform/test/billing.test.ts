import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { loadPlanRegistry } from "@xos/schemas/plans";
import {
  BillingNotConfiguredError,
  PriceNotFoundError,
  StripeSignatureError,
  createCheckoutSession,
  createPortalSession,
  createStripeClient,
  handleStripeWebhook,
  isTestKey,
  lookupKeyFor,
  planForLookupKey,
  readBillingEnv,
  resolvePriceId,
  type BillingStore,
  type StripeClient,
} from "../src/index.ts";

const registry = loadPlanRegistry();
const secret = "whsec_testsigningsecret";

/** A Stripe client that answers from memory; it never reaches the network and needs no key. */
function fakeStripe(prices: Record<string, string>) {
  const calls: { method: string; params: unknown }[] = [];
  const client = {
    prices: {
      list: async (params: { lookup_keys?: string[] }) => {
        calls.push({ method: "prices.list", params });
        const key = params.lookup_keys?.[0] ?? "";
        return { data: prices[key] === undefined ? [] : [{ id: prices[key], lookup_key: key }] };
      },
    },
    checkout: {
      sessions: {
        create: async (params: unknown) => {
          calls.push({ method: "checkout.sessions.create", params });
          return { id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (params: unknown) => {
          calls.push({ method: "billingPortal.sessions.create", params });
          return { url: "https://billing.stripe.test/p/1" };
        },
      },
    },
  } as unknown as StripeClient;
  return { client, calls };
}

function memoryStore(options: { orgForCustomer?: string | null; failSync?: boolean } = {}) {
  const events = new Map<
    string,
    { rowId: string; processed: boolean; error: string | null; orgId: string | null }
  >();
  const syncs: Parameters<BillingStore["syncSubscription"]>[0][] = [];
  const store: BillingStore = {
    async recordStripeEvent(event) {
      const existing = events.get(event.id);
      if (existing !== undefined)
        return { rowId: existing.rowId, isNew: false, processed: existing.processed };
      const row = {
        rowId: `row-${events.size + 1}`,
        processed: false,
        error: null,
        orgId: event.orgId,
      };
      events.set(event.id, row);
      return { rowId: row.rowId, isNew: true, processed: false };
    },
    async finishStripeEvent(rowId, error) {
      for (const row of events.values()) {
        if (row.rowId === rowId) {
          row.processed = error === null;
          row.error = error;
        }
      }
    },
    async orgForCustomer() {
      return options.orgForCustomer ?? null;
    },
    async syncSubscription(input) {
      if (options.failSync)
        throw new Error(
          "subscription_transition_not_allowed: A subscription cannot move from canceled to active.",
        );
      syncs.push(input);
      return input.status === "past_due" ? "past_due" : "active";
    },
  };
  return { store, events, syncs };
}

function subscriptionEvent(
  overrides: {
    type?: string;
    status?: string;
    lookupKey?: string | null;
    orgId?: string | null;
    livemode?: boolean;
    id?: string;
  } = {},
) {
  return {
    id: overrides.id ?? "evt_test_1",
    object: "event",
    type: overrides.type ?? "customer.subscription.updated",
    livemode: overrides.livemode ?? false,
    created: 1_790_000_000,
    api_version: "2026-09-30",
    data: {
      object: {
        id: "sub_test_1",
        object: "subscription",
        customer: "cus_test_1",
        status: overrides.status ?? "active",
        metadata: overrides.orgId === null ? {} : { org_id: overrides.orgId ?? "org-1" },
        items: {
          data: [
            {
              id: "si_1",
              current_period_end: 1_792_000_000,
              price: {
                id: "price_1",
                lookup_key:
                  overrides.lookupKey === undefined
                    ? "atlvs_plan_pro_unlimited_monthly_v3"
                    : overrides.lookupKey,
              },
            },
          ],
        },
      },
    },
  };
}

function signed(event: unknown): { rawBody: string; signature: string } {
  const rawBody = JSON.stringify(event);
  return {
    rawBody,
    signature: Stripe.webhooks.generateTestHeaderString({ payload: rawBody, secret }),
  };
}

describe("environment", () => {
  it("runs without a Stripe key and refuses Stripe calls clearly", () => {
    const env = readBillingEnv({});
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.XOS_APP_URL).toBe("http://127.0.0.1:3000");
    expect(() => createStripeClient(env)).toThrow(BillingNotConfiguredError);
  });

  it("validates key shapes and names the bad variable", () => {
    expect(() => readBillingEnv({ STRIPE_SECRET_KEY: "pk_test_abc" })).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => readBillingEnv({ STRIPE_WEBHOOK_SECRET: "secret" })).toThrow(
      /STRIPE_WEBHOOK_SECRET/,
    );
    expect(isTestKey("sk_test_abcdefgh")).toBe(true);
    expect(isTestKey("rk_live_abcdefgh")).toBe(false);
  });

  it("builds the client from the key through the injected factory", () => {
    const env = readBillingEnv({ STRIPE_SECRET_KEY: "sk_test_abcdefghij" });
    let used = "";
    const client = createStripeClient(env, (key) => {
      used = key;
      return fakeStripe({}).client;
    });
    expect(used).toBe("sk_test_abcdefghij");
    expect(client.prices).toBeDefined();
  });
});

describe("plans and lookup keys", () => {
  it("maps every paid plan's lookup keys from plans.yaml both ways", () => {
    for (const plan of registry.plans.filter((p) => p.stripe !== null)) {
      expect(planForLookupKey(registry, lookupKeyFor(registry, plan.code, "Monthly"))).toEqual({
        planCode: plan.code,
        interval: "Monthly",
      });
      expect(planForLookupKey(registry, lookupKeyFor(registry, plan.code, "Annual"))).toEqual({
        planCode: plan.code,
        interval: "Annual",
      });
    }
  });

  it("knows no price for the free plan or a key no plan sells", () => {
    expect(() => lookupKeyFor(registry, "access", "Monthly")).toThrow(/free/);
    expect(() => lookupKeyFor(registry, "platinum", "Monthly")).toThrow(/Unknown plan/);
    expect(planForLookupKey(registry, "atlvs_plan_core_per_project_monthly_v3")).toBeNull();
    expect(planForLookupKey(registry, null)).toBeNull();
  });
});

describe("checkout", () => {
  it("resolves the price by lookup key at runtime and puts the org in the metadata", async () => {
    const key = lookupKeyFor(registry, "team", "Annual");
    const { client, calls } = fakeStripe({ [key]: "price_team_annual" });
    const session = await createCheckoutSession(client, registry, {
      orgId: "org-1",
      planCode: "team",
      interval: "Annual",
      customerEmail: "billing@northwind.test",
      successUrl: "https://atlas.xos.test/ok",
      cancelUrl: "https://atlas.xos.test/cancel",
    });
    expect(session).toEqual({
      sessionId: "cs_test_1",
      url: "https://checkout.stripe.test/cs_test_1",
    });
    expect(calls[0]).toEqual({
      method: "prices.list",
      params: { lookup_keys: [key], active: true, limit: 1 },
    });
    expect(calls[1]?.params).toMatchObject({
      mode: "subscription",
      line_items: [{ price: "price_team_annual", quantity: 1 }],
      metadata: { org_id: "org-1" },
      subscription_data: { metadata: { org_id: "org-1" } },
      customer_email: "billing@northwind.test",
      automatic_tax: { enabled: true },
    });
  });

  it("uses an existing customer and opens the portal", async () => {
    const key = lookupKeyFor(registry, "core", "Monthly");
    const { client, calls } = fakeStripe({ [key]: "price_core" });
    await createCheckoutSession(client, registry, {
      orgId: "org-1",
      planCode: "core",
      interval: "Monthly",
      customerId: "cus_1",
      successUrl: "https://a.test/ok",
      cancelUrl: "https://a.test/no",
    });
    expect(calls[1]?.params).toMatchObject({ customer: "cus_1" });
    await expect(createPortalSession(client, "cus_1", "https://a.test/billing")).resolves.toBe(
      "https://billing.stripe.test/p/1",
    );
  });

  it("never creates a missing price; it refuses", async () => {
    const { client, calls } = fakeStripe({});
    await expect(
      resolvePriceId(client, "atlvs_plan_pro_unlimited_monthly_v3"),
    ).rejects.toBeInstanceOf(PriceNotFoundError);
    expect(calls.map((c) => c.method)).toEqual(["prices.list"]);
  });
});

describe("Stripe webhook", () => {
  it("refuses a missing or wrong signature", async () => {
    const { store } = memoryStore();
    const { rawBody } = signed(subscriptionEvent());
    await expect(
      handleStripeWebhook({
        rawBody,
        signature: null,
        webhookSecret: secret,
        livemode: false,
        registry,
        store,
      }),
    ).rejects.toBeInstanceOf(StripeSignatureError);
    await expect(
      handleStripeWebhook({
        rawBody,
        signature: "t=1,v1=00",
        webhookSecret: secret,
        livemode: false,
        registry,
        store,
      }),
    ).rejects.toBeInstanceOf(StripeSignatureError);
  });

  it("applies a subscription event once, with the plan from the lookup key", async () => {
    const { store, syncs } = memoryStore();
    const request = {
      ...signed(subscriptionEvent()),
      webhookSecret: secret,
      livemode: false,
      registry,
      store,
    };
    await expect(handleStripeWebhook(request)).resolves.toEqual({
      outcome: "applied",
      eventId: "evt_test_1",
      state: "active",
    });
    expect(syncs[0]).toMatchObject({
      orgId: "org-1",
      customerId: "cus_test_1",
      subscriptionId: "sub_test_1",
      planCode: "pro",
      interval: "Monthly",
    });
    expect(syncs[0]?.currentPeriodEnd?.toISOString()).toBe(
      new Date(1_792_000_000 * 1000).toISOString(),
    );
    await expect(handleStripeWebhook(request)).resolves.toEqual({
      outcome: "duplicate",
      eventId: "evt_test_1",
    });
    expect(syncs).toHaveLength(1);
  });

  it("treats a deleted subscription as canceled and resolves the org from the customer", async () => {
    const { store, syncs } = memoryStore({ orgForCustomer: "org-9" });
    const event = subscriptionEvent({
      type: "customer.subscription.deleted",
      status: "active",
      orgId: null,
    });
    await handleStripeWebhook({
      ...signed(event),
      webhookSecret: secret,
      livemode: false,
      registry,
      store,
    });
    expect(syncs[0]).toMatchObject({ orgId: "org-9", status: "canceled" });
  });

  it("stores but ignores events of the other mode, other types, unknown orgs and non-plan prices", async () => {
    const cases = [
      { event: subscriptionEvent({ id: "evt_live", livemode: true }), reason: /mode/ },
      {
        event: { ...subscriptionEvent({ id: "evt_inv" }), type: "invoice.paid" },
        reason: /No action/,
      },
      { event: subscriptionEvent({ id: "evt_noorg", orgId: null }), reason: /no org/ },
      {
        event: subscriptionEvent({
          id: "evt_price",
          lookupKey: "atlvs_plan_pro_per_project_monthly_v3",
        }),
        reason: /not a plan price/,
      },
    ];
    for (const { event, reason } of cases) {
      const { store, events, syncs } = memoryStore();
      const outcome = await handleStripeWebhook({
        ...signed(event),
        webhookSecret: secret,
        livemode: false,
        registry,
        store,
      });
      expect(outcome.outcome).toBe("ignored");
      if (outcome.outcome === "ignored") expect(outcome.reason).toMatch(reason);
      expect(events.size).toBe(1);
      expect([...events.values()][0]?.processed).toBe(true);
      expect(syncs).toHaveLength(0);
    }
  });

  it("records a refused sync for retry and applies it on redelivery", async () => {
    const failing = memoryStore({ failSync: true });
    const request = {
      ...signed(subscriptionEvent()),
      webhookSecret: secret,
      livemode: false,
      registry,
      store: failing.store,
    };
    const outcome = await handleStripeWebhook(request);
    expect(outcome.outcome).toBe("failed");
    expect([...failing.events.values()][0]?.error).toMatch(/subscription_transition_not_allowed/);
    expect([...failing.events.values()][0]?.processed).toBe(false);
  });
});
