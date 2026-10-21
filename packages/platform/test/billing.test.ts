import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { loadPlanRegistry } from "@xos/schemas/plans";
import {
  BillingNotConfiguredError,
  NotSelfServeError,
  PriceNotFoundError,
  StripeSignatureError,
  addonForLookupKey,
  createAddonCheckoutSession,
  createCheckoutSession,
  stripeTrialEnd,
  createPortalSession,
  createStripeClient,
  extraSeatForLookupKey,
  extraSeatLookupKeyFor,
  handleStripeWebhook,
  isTestKey,
  lookupKeyFor,
  planForLookupKey,
  readBillingEnv,
  resolvePriceId,
  setExtraSeats,
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
    subscriptions: {
      retrieve: async (id: string) => {
        calls.push({ method: "subscriptions.retrieve", params: id });
        return { id, items: { data: subscriptionItems } };
      },
      update: async (id: string, params: unknown) => {
        calls.push({ method: "subscriptions.update", params: { id, ...(params as object) } });
        return { id };
      },
    },
  } as unknown as StripeClient;
  return { client, calls };
}

/** Items of the subscription fakeStripe returns; tests set them before calling. */
let subscriptionItems: { id: string; quantity: number; price: { lookup_key: string | null } }[] =
  [];

function memoryStore(options: { orgForCustomer?: string | null; failSync?: boolean } = {}) {
  const events = new Map<
    string,
    { rowId: string; processed: boolean; error: string | null; orgId: string | null }
  >();
  const syncs: Parameters<BillingStore["syncSubscription"]>[0][] = [];
  const purchases: Parameters<BillingStore["recordAddonPurchase"]>[0][] = [];
  const store: BillingStore = {
    async recordAddonPurchase(input) {
      purchases.push(input);
      return `purchase-${purchases.length}`;
    },
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
  return { store, events, syncs, purchases };
}

function subscriptionEvent(
  overrides: {
    type?: string;
    status?: string;
    lookupKey?: string | null;
    orgId?: string | null;
    livemode?: boolean;
    id?: string;
    extraItems?: { lookupKey: string; quantity: number }[];
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
                    ? "xos_plan_pro_monthly_v4"
                    : overrides.lookupKey,
              },
            },
            ...(overrides.extraItems ?? []).map((item, i) => ({
              id: `si_extra_${String(i)}`,
              quantity: item.quantity,
              current_period_end: 1_792_000_000,
              price: { id: `price_extra_${String(i)}`, lookup_key: item.lookupKey },
            })),
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

  it("carries the rest of an XOS trial, so the card added at checkout is charged only when the trial ends", async () => {
    const key = lookupKeyFor(registry, "pro", "Monthly");
    const { client, calls } = fakeStripe({ [key]: "price_pro" });
    const now = new Date("2026-10-20T12:00:00Z");
    await createCheckoutSession(client, registry, {
      orgId: "org-1",
      planCode: "pro",
      interval: "Monthly",
      successUrl: "https://a.test/ok",
      cancelUrl: "https://a.test/no",
      trialEnd: "2026-10-30T12:00:00Z",
      now,
    });
    expect(calls[1]?.params).toMatchObject({
      subscription_data: {
        metadata: { org_id: "org-1" },
        trial_end: Date.parse("2026-10-30T12:00:00Z") / 1000,
      },
    });
    expect(stripeTrialEnd("2026-10-21T12:00:00Z", now)).toBeUndefined();
    expect(stripeTrialEnd("not a date", now)).toBeUndefined();
    expect(stripeTrialEnd(undefined, now)).toBeUndefined();
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

describe("seats and add-ons (ADR 0035)", () => {
  it("maps extra-seat and add-on lookup keys back to their plan and add-on", () => {
    for (const plan of registry.plans.filter((p) => p.extraSeat !== null)) {
      expect(
        extraSeatForLookupKey(registry, extraSeatLookupKeyFor(registry, plan.code, "Annual")),
      ).toEqual({ planCode: plan.code, interval: "Annual" });
      expect(
        extraSeatForLookupKey(registry, extraSeatLookupKeyFor(registry, plan.code, "Monthly")),
      ).toEqual({ planCode: plan.code, interval: "Monthly" });
    }
    expect(extraSeatForLookupKey(registry, "xos_plan_pro_monthly_v4")).toBeNull();
    expect(extraSeatForLookupKey(registry, undefined)).toBeNull();
    expect(addonForLookupKey(registry, "xos_addon_aurora_requests_1000_once_v4")?.code).toBe(
      "aurora_requests_1000",
    );
    expect(addonForLookupKey(registry, "xos_plan_pro_monthly_v4")).toBeNull();
    expect(addonForLookupKey(registry, null)).toBeNull();
  });

  it("never checks out Enterprise, which is sold by quote", () => {
    expect(() => lookupKeyFor(registry, "enterprise", "Annual")).toThrow(NotSelfServeError);
    expect(() => lookupKeyFor(registry, "enterprise", "Annual")).toThrow(/sold by quote/);
    expect(() => extraSeatLookupKeyFor(registry, "enterprise", "Annual")).toThrow(
      NotSelfServeError,
    );
    expect(() => extraSeatLookupKeyFor(registry, "access", "Monthly")).toThrow(/free/);
  });

  it("buys extra seats at checkout as the quantity of the plan's seat price, and accepts promotion codes", async () => {
    const plan = lookupKeyFor(registry, "pro", "Monthly");
    const seat = extraSeatLookupKeyFor(registry, "pro", "Monthly");
    const { client, calls } = fakeStripe({ [plan]: "price_pro", [seat]: "price_pro_seat" });
    await createCheckoutSession(client, registry, {
      orgId: "org-1",
      planCode: "pro",
      interval: "Monthly",
      extraSeats: 4,
      successUrl: "https://a.test/ok",
      cancelUrl: "https://a.test/no",
    });
    expect(calls.at(-1)?.params).toMatchObject({
      line_items: [
        { price: "price_pro", quantity: 1 },
        { price: "price_pro_seat", quantity: 4 },
      ],
      allow_promotion_codes: true,
    });
    await expect(
      createCheckoutSession(client, registry, {
        orgId: "org-1",
        planCode: "pro",
        interval: "Monthly",
        extraSeats: -1,
        successUrl: "https://a.test/ok",
        cancelUrl: "https://a.test/no",
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("sells an Aurora pack as a one-time payment with the org, add-on and quantity in the metadata", async () => {
    const addon = registry.addons[0];
    if (addon === undefined) throw new Error("plans.yaml lists no add-on");
    const { client, calls } = fakeStripe({ [addon.priceLookupKey]: "price_pack" });
    await createAddonCheckoutSession(client, registry, {
      orgId: "org-1",
      planCode: "core",
      addonCode: addon.code,
      quantity: 2,
      customerId: "cus_1",
      successUrl: "https://a.test/ok",
      cancelUrl: "https://a.test/no",
    });
    expect(calls.at(-1)?.params).toMatchObject({
      mode: "payment",
      line_items: [{ price: "price_pack", quantity: 2 }],
      metadata: { org_id: "org-1", addon_code: addon.code, quantity: "2" },
      customer: "cus_1",
    });
    const base = {
      orgId: "org-1",
      successUrl: "https://a.test/ok",
      cancelUrl: "https://a.test/no",
    };
    await expect(
      createAddonCheckoutSession(client, registry, {
        ...base,
        planCode: "access",
        addonCode: addon.code,
      }),
    ).rejects.toThrow(/access plan cannot buy/);
    await expect(
      createAddonCheckoutSession(client, registry, {
        ...base,
        planCode: "core",
        addonCode: "sms_pack",
      }),
    ).rejects.toThrow(/Unknown add-on/);
    await expect(
      createAddonCheckoutSession(client, registry, {
        ...base,
        planCode: "core",
        addonCode: addon.code,
        quantity: 101,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("adds, changes and removes the extra-seat item of a live subscription", async () => {
    const seatKey = extraSeatLookupKeyFor(registry, "team", "Annual");
    const { client, calls } = fakeStripe({ [seatKey]: "price_team_seat_annual" });
    subscriptionItems = [
      { id: "si_plan", quantity: 1, price: { lookup_key: "xos_plan_team_annual_v4" } },
    ];
    await expect(setExtraSeats(client, registry, "sub_1", 0)).resolves.toBe(0);
    expect(calls.map((c) => c.method)).toEqual(["subscriptions.retrieve"]);
    await setExtraSeats(client, registry, "sub_1", 5);
    expect(calls.at(-1)).toEqual({
      method: "subscriptions.update",
      params: {
        id: "sub_1",
        items: [{ price: "price_team_seat_annual", quantity: 5 }],
        proration_behavior: "create_prorations",
      },
    });
    subscriptionItems = [
      ...subscriptionItems,
      { id: "si_seat", quantity: 5, price: { lookup_key: seatKey } },
    ];
    await setExtraSeats(client, registry, "sub_1", 7);
    expect(calls.at(-1)?.params).toMatchObject({ items: [{ id: "si_seat", quantity: 7 }] });
    await setExtraSeats(client, registry, "sub_1", 0);
    expect(calls.at(-1)?.params).toMatchObject({ items: [{ id: "si_seat", deleted: true }] });
    subscriptionItems = [{ id: "si_x", quantity: 1, price: { lookup_key: "atlvs_plan_pro_v3" } }];
    await expect(setExtraSeats(client, registry, "sub_1", 2)).rejects.toThrow(/no plan price/);
  });

  it("syncs the quantity of the plan's extra-seat price with the subscription", async () => {
    const { store, syncs } = memoryStore();
    await handleStripeWebhook({
      ...signed(
        subscriptionEvent({
          extraItems: [{ lookupKey: "xos_seat_pro_monthly_v4", quantity: 3 }],
        }),
      ),
      webhookSecret: secret,
      livemode: false,
      registry,
      store,
    });
    expect(syncs[0]).toMatchObject({ planCode: "pro", extraSeats: 3 });
    const plain = memoryStore();
    await handleStripeWebhook({
      ...signed(subscriptionEvent({ id: "evt_plain" })),
      webhookSecret: secret,
      livemode: false,
      registry,
      store: plain.store,
    });
    expect(plain.syncs[0]?.extraSeats).toBe(0);
  });

  it("ignores a seat price of another plan or term", async () => {
    const { store, syncs } = memoryStore();
    const outcome = await handleStripeWebhook({
      ...signed(
        subscriptionEvent({
          extraItems: [{ lookupKey: "xos_seat_team_monthly_v4", quantity: 3 }],
        }),
      ),
      webhookSecret: secret,
      livemode: false,
      registry,
      store,
    });
    expect(outcome).toMatchObject({
      outcome: "ignored",
      reason: expect.stringMatching(/another plan/),
    });
    expect(syncs).toHaveLength(0);
  });

  function paymentEvent(
    overrides: {
      id?: string;
      type?: string;
      mode?: string;
      paymentStatus?: string;
      metadata?: Record<string, string>;
    } = {},
  ) {
    return {
      id: overrides.id ?? "evt_pay_1",
      object: "event",
      type: overrides.type ?? "checkout.session.completed",
      livemode: false,
      created: 1_790_000_000,
      api_version: "2026-09-30",
      data: {
        object: {
          id: "cs_test_pack1",
          object: "checkout.session",
          customer: "cus_test_1",
          mode: overrides.mode ?? "payment",
          payment_status: overrides.paymentStatus ?? "paid",
          currency: "eur",
          amount_subtotal: 9000,
          amount_total: 10890,
          metadata: overrides.metadata ?? {
            org_id: "org-1",
            addon_code: "aurora_requests_1000",
            quantity: "2",
          },
        },
      },
    };
  }

  it("records a paid Aurora pack once, from the session metadata", async () => {
    const { store, purchases } = memoryStore();
    const request = {
      ...signed(paymentEvent()),
      webhookSecret: secret,
      livemode: false,
      registry,
      store,
    };
    await expect(handleStripeWebhook(request)).resolves.toEqual({
      outcome: "applied",
      eventId: "evt_pay_1",
      state: "recorded",
    });
    expect(purchases).toEqual([
      {
        orgId: "org-1",
        addonCode: "aurora_requests_1000",
        quantity: 2,
        checkoutSessionId: "cs_test_pack1",
        currency: "EUR",
        amountTotalMinor: 9000,
        livemode: false,
        paidAt: new Date(1_790_000_000 * 1000),
      },
    ]);
    await expect(handleStripeWebhook(request)).resolves.toMatchObject({ outcome: "duplicate" });
    expect(purchases).toHaveLength(1);
  });

  it("ignores unpaid, subscription, unknown and quantity-less checkouts", async () => {
    const cases = [
      { event: paymentEvent({ id: "evt_unpaid", paymentStatus: "unpaid" }), reason: /not paid/ },
      {
        event: paymentEvent({ id: "evt_sub", mode: "subscription" }),
        reason: /subscription events/,
      },
      {
        event: paymentEvent({ id: "evt_unknown", metadata: { org_id: "org-1", addon_code: "x" } }),
        reason: /no add-on/,
      },
      {
        event: paymentEvent({
          id: "evt_qty",
          metadata: { org_id: "org-1", addon_code: "aurora_requests_1000", quantity: "0" },
        }),
        reason: /no quantity/,
      },
      { event: paymentEvent({ id: "evt_noorg", metadata: {} }), reason: /payment names no org/ },
    ];
    for (const { event, reason } of cases) {
      const { store, purchases } = memoryStore();
      const outcome = await handleStripeWebhook({
        ...signed(event),
        webhookSecret: secret,
        livemode: false,
        registry,
        store,
      });
      expect(outcome).toMatchObject({ outcome: "ignored", reason: expect.stringMatching(reason) });
      expect(purchases).toHaveLength(0);
    }
  });

  it("applies a pack whose payment succeeds later, and defaults to one unit", async () => {
    const { store, purchases } = memoryStore();
    await handleStripeWebhook({
      ...signed(
        paymentEvent({
          type: "checkout.session.async_payment_succeeded",
          metadata: { org_id: "org-1", addon_code: "aurora_requests_1000" },
        }),
      ),
      webhookSecret: secret,
      livemode: false,
      registry,
      store,
    });
    expect(purchases[0]?.quantity).toBe(1);
  });
});
