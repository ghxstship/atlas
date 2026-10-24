import { describe, expect, it } from "vitest";
import { loadPlanRegistry } from "@xos/schemas/plans";
import {
  CheckoutCompletedError,
  NotSelfServeError,
  PORTAL_CONFIGURATION_KEY,
  expireCheckoutSession,
  lookupKeyFor,
  openBillingPortal,
  startPlanCheckout,
  type CheckoutAccountStore,
  type StripeClient,
} from "../src/billing/index.ts";

/**
 * Moving an org onto a paid plan and managing it (ADR 0033 decision 59), against a fake Stripe
 * account held in memory and a fake of the 1640 RPCs. Nothing reaches the network.
 */

const registry = loadPlanRegistry();

type Status = "open" | "complete" | "expired";

function fakeStripe(
  options: {
    sessions?: Record<string, Status>;
    /** Sessions whose expire call fails, and what Stripe says about them afterwards. */
    expireFails?: Record<string, Status>;
    /** Sessions this Stripe account does not have, such as ones opened under an earlier sandbox key. */
    missing?: string[];
    portalConfigured?: boolean;
  } = {},
) {
  const sessions = new Map<string, Status>(Object.entries(options.sessions ?? {}));
  const calls: { method: string; params: unknown }[] = [];
  let next = 1;
  const prices = Object.fromEntries(
    registry.plans.flatMap((p) =>
      p.stripe === null
        ? []
        : [
            [p.stripe.monthlyPriceLookupKey, `price_${p.code}_monthly`],
            [p.stripe.annualPriceLookupKey, `price_${p.code}_annual`],
          ],
    ),
  );
  const client = {
    prices: {
      list: async (params: { lookup_keys: string[] }) => {
        calls.push({ method: "prices.list", params });
        const key = params.lookup_keys[0] ?? "";
        return { data: prices[key] === undefined ? [] : [{ id: prices[key], lookup_key: key }] };
      },
    },
    checkout: {
      sessions: {
        create: async (params: unknown) => {
          const id = `cs_test_New${String(next++)}`;
          calls.push({ method: "checkout.sessions.create", params });
          sessions.set(id, "open");
          return { id, url: `https://checkout.stripe.test/${id}`, expires_at: 1_790_086_400 };
        },
        retrieve: async (id: string) => {
          calls.push({ method: "checkout.sessions.retrieve", params: id });
          if (options.missing?.includes(id)) {
            throw Object.assign(new Error(`No such checkout.session: '${id}'`), {
              type: "StripeInvalidRequestError",
              code: "resource_missing",
              statusCode: 404,
            });
          }
          return { id, status: sessions.get(id) ?? "expired" };
        },
        expire: async (id: string) => {
          calls.push({ method: "checkout.sessions.expire", params: id });
          const after = options.expireFails?.[id];
          if (after !== undefined) {
            sessions.set(id, after);
            throw Object.assign(new Error("Only open sessions can be expired"), {
              statusCode: 400,
            });
          }
          sessions.set(id, "expired");
          return { id, status: "expired" };
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
      configurations: {
        list: async () => ({
          data:
            options.portalConfigured === false
              ? []
              : [{ id: "bpc_xos", metadata: { xos_portal: PORTAL_CONFIGURATION_KEY } }],
        }),
      },
    },
    subscriptions: { retrieve: async () => ({}), update: async () => ({}) },
  } as unknown as StripeClient;
  return { client, calls, sessions };
}

/** The 1640 RPCs in memory: refusals are thrown errors, as Atlas's store over @xos/data throws them. */
function accountStore(
  options: {
    customerId?: string | null;
    trialEndsAt?: string | null;
    openSessionIds?: string[];
    /** Open sessions another tab recorded meanwhile, which record() closes. */
    closedByRecord?: string[];
    refuse?: string;
  } = {},
) {
  const recorded: Parameters<CheckoutAccountStore["record"]>[0][] = [];
  const begun: Parameters<CheckoutAccountStore["begin"]>[0][] = [];
  const store: CheckoutAccountStore = {
    async begin(input) {
      begun.push(input);
      if (options.refuse !== undefined) throw new Error(options.refuse);
      return {
        customerId: options.customerId ?? null,
        trialEndsAt: options.trialEndsAt ?? null,
        openSessionIds: options.openSessionIds ?? [],
      };
    },
    async record(input) {
      recorded.push(input);
      return options.closedByRecord ?? [];
    },
    async portalCustomer() {
      if (options.refuse !== undefined) throw new Error(options.refuse);
      return options.customerId ?? "cus_none";
    },
  };
  return { store, recorded, begun };
}

const request = {
  orgId: "org-1",
  planCode: "core",
  interval: "Monthly" as const,
  livemode: false,
  customerEmail: "owner@northwind.test",
  successUrl: "https://atlas.test/northwind/settings/billing-and-plan?checkout=done",
  cancelUrl: "https://atlas.test/northwind/settings/billing-and-plan?checkout=canceled",
  now: new Date("2026-10-23T12:00:00Z"),
};

describe("startPlanCheckout", () => {
  it("opens an org's first checkout with the Owner's email and carries the rest of its trial", async () => {
    const stripe = fakeStripe();
    const account = accountStore({ trialEndsAt: "2026-11-05T05:00:00Z" });
    const opened = await startPlanCheckout(stripe.client, registry, account.store, request);
    expect(opened).toEqual({
      sessionId: "cs_test_New1",
      url: "https://checkout.stripe.test/cs_test_New1",
    });
    expect(account.begun).toEqual([{ orgId: "org-1", planCode: "core", livemode: false }]);
    const created = stripe.calls.find((c) => c.method === "checkout.sessions.create");
    expect(created?.params).toMatchObject({
      mode: "subscription",
      line_items: [{ price: "price_core_monthly", quantity: 1 }],
      customer_email: "owner@northwind.test",
      metadata: { org_id: "org-1" },
      subscription_data: {
        metadata: { org_id: "org-1" },
        trial_end: Date.parse("2026-11-05T05:00:00Z") / 1000,
      },
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
    });
    expect(account.recorded).toEqual([
      {
        orgId: "org-1",
        planCode: "core",
        interval: "Monthly",
        sessionId: "cs_test_New1",
        livemode: false,
        expiresAt: new Date(1_790_086_400 * 1000),
      },
    ]);
  });

  it("reuses the org's Stripe customer and never sends a trial it does not have", async () => {
    const stripe = fakeStripe();
    const account = accountStore({ customerId: "cus_N1na" });
    await startPlanCheckout(stripe.client, registry, account.store, {
      ...request,
      planCode: "team",
      interval: "Annual",
    });
    const created = stripe.calls.find((c) => c.method === "checkout.sessions.create");
    expect(created?.params).toMatchObject({
      customer: "cus_N1na",
      line_items: [{ price: "price_team_annual", quantity: 1 }],
    });
    expect(created?.params).not.toHaveProperty("customer_email");
    expect((created?.params as { subscription_data: object }).subscription_data).not.toHaveProperty(
      "trial_end",
    );
  });

  it("expires the org's open checkouts before opening another", async () => {
    const stripe = fakeStripe({ sessions: { cs_test_Old1: "open", cs_test_Old2: "expired" } });
    const account = accountStore({ openSessionIds: ["cs_test_Old1", "cs_test_Old2"] });
    await startPlanCheckout(stripe.client, registry, account.store, request);
    expect(stripe.sessions.get("cs_test_Old1")).toBe("expired");
    expect(stripe.calls.filter((c) => c.method === "checkout.sessions.expire")).toEqual([
      { method: "checkout.sessions.expire", params: "cs_test_Old1" },
    ]);
  });

  it("stops when an open checkout was paid meanwhile, so the org never pays twice", async () => {
    const stripe = fakeStripe({ sessions: { cs_test_Paid: "complete" } });
    const account = accountStore({ openSessionIds: ["cs_test_Paid"] });
    await expect(
      startPlanCheckout(stripe.client, registry, account.store, request),
    ).rejects.toBeInstanceOf(CheckoutCompletedError);
    expect(stripe.calls.some((c) => c.method === "checkout.sessions.create")).toBe(false);
    expect(account.recorded).toEqual([]);
  });

  it("closes the new session when a checkout another tab opened turns out paid", async () => {
    const stripe = fakeStripe({ sessions: { cs_test_Tab: "complete" } });
    const account = accountStore({ closedByRecord: ["cs_test_Tab"] });
    await expect(
      startPlanCheckout(stripe.client, registry, account.store, request),
    ).rejects.toBeInstanceOf(CheckoutCompletedError);
    expect(stripe.sessions.get("cs_test_New1")).toBe("expired");
  });

  it("treats an open session the Stripe account does not have as gone, so Checkout still opens", async () => {
    const stripe = fakeStripe({ missing: ["cs_test_OldKey"] });
    const account = accountStore({
      openSessionIds: ["cs_test_OldKey"],
      closedByRecord: ["cs_test_OldKey"],
    });
    const opened = await startPlanCheckout(stripe.client, registry, account.store, request);
    expect(opened.sessionId).toBe("cs_test_New1");
    expect(stripe.calls.some((c) => c.method === "checkout.sessions.expire")).toBe(false);
  });

  it("expires a session another tab opened, and lets an expiry Stripe already did pass", async () => {
    const stripe = fakeStripe({ sessions: { cs_test_Tab: "open" } });
    const account = accountStore({ closedByRecord: ["cs_test_Tab"] });
    await startPlanCheckout(stripe.client, registry, account.store, request);
    expect(stripe.sessions.get("cs_test_Tab")).toBe("expired");
    expect(stripe.sessions.get("cs_test_New1")).toBe("open");
  });

  it("refuses Access and Enterprise before asking the database", async () => {
    const stripe = fakeStripe();
    const account = accountStore();
    for (const planCode of ["access", "enterprise"]) {
      await expect(
        startPlanCheckout(stripe.client, registry, account.store, { ...request, planCode }),
      ).rejects.toBeInstanceOf(NotSelfServeError);
    }
    expect(account.begun).toEqual([]);
    expect(stripe.calls).toEqual([]);
  });

  it("calls Stripe only once the database's checks passed", async () => {
    const stripe = fakeStripe();
    const account = accountStore({ refuse: "step_up_required" });
    await expect(
      startPlanCheckout(stripe.client, registry, account.store, request),
    ).rejects.toThrow("step_up_required");
    expect(stripe.calls).toEqual([]);
  });

  it("reads every price from plans.yaml by lookup key", async () => {
    const stripe = fakeStripe();
    await startPlanCheckout(stripe.client, registry, accountStore().store, {
      ...request,
      planCode: "pro",
      interval: "Annual",
    });
    expect(stripe.calls[0]).toEqual({
      method: "prices.list",
      params: { lookup_keys: [lookupKeyFor(registry, "pro", "Annual")], active: true, limit: 1 },
    });
  });
});

describe("expireCheckoutSession", () => {
  it("lets Stripe's answer decide when the expiry races a payment or an expiry", async () => {
    const paid = fakeStripe({
      sessions: { cs_test_R: "open" },
      expireFails: { cs_test_R: "complete" },
    });
    await expect(expireCheckoutSession(paid.client, "cs_test_R")).rejects.toBeInstanceOf(
      CheckoutCompletedError,
    );
    const lapsed = fakeStripe({
      sessions: { cs_test_R: "open" },
      expireFails: { cs_test_R: "expired" },
    });
    await expect(expireCheckoutSession(lapsed.client, "cs_test_R")).resolves.toBeUndefined();
    const stuck = fakeStripe({
      sessions: { cs_test_R: "open" },
      expireFails: { cs_test_R: "open" },
    });
    await expect(expireCheckoutSession(stuck.client, "cs_test_R")).rejects.toThrow(
      /Only open sessions/,
    );
  });

  it("passes on any other Stripe failure", async () => {
    const stripe = fakeStripe();
    const down = {
      ...stripe.client,
      checkout: {
        sessions: {
          retrieve: async () => {
            throw Object.assign(new Error("Stripe is unavailable"), { statusCode: 503 });
          },
        },
      },
    } as unknown as StripeClient;
    await expect(expireCheckoutSession(down, "cs_test_R")).rejects.toThrow(/unavailable/);
  });
});

describe("openBillingPortal", () => {
  it("opens the portal on the org's customer with the configuration stripe:setup created", async () => {
    const stripe = fakeStripe();
    const url = await openBillingPortal(
      stripe.client,
      accountStore({ customerId: "cus_N1na" }).store,
      {
        orgId: "org-1",
        livemode: false,
        returnUrl: "https://atlas.test/northwind/settings/billing-and-plan",
      },
    );
    expect(url).toBe("https://billing.stripe.test/p/1");
    expect(stripe.calls.at(-1)).toEqual({
      method: "billingPortal.sessions.create",
      params: {
        customer: "cus_N1na",
        return_url: "https://atlas.test/northwind/settings/billing-and-plan",
        configuration: "bpc_xos",
      },
    });
  });

  it("falls back to the account's default portal before stripe:setup has run", async () => {
    const stripe = fakeStripe({ portalConfigured: false });
    await openBillingPortal(stripe.client, accountStore({ customerId: "cus_N1na" }).store, {
      orgId: "org-1",
      livemode: false,
      returnUrl: "https://atlas.test/b",
    });
    expect(stripe.calls.at(-1)?.params).toEqual({
      customer: "cus_N1na",
      return_url: "https://atlas.test/b",
    });
  });

  it("opens nothing when the database refuses", async () => {
    const stripe = fakeStripe();
    await expect(
      openBillingPortal(stripe.client, accountStore({ refuse: "billing_no_customer" }).store, {
        orgId: "org-1",
        livemode: false,
        returnUrl: "https://atlas.test/b",
      }),
    ).rejects.toThrow("billing_no_customer");
    expect(stripe.calls).toEqual([]);
  });
});
