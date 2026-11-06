import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { loadPlanRegistry } from "@xos/schemas/plans";
import {
  CHECKOUT_MESSAGE_MAX,
  RENEWAL_TERMS_VERSION,
  STRIPE_WORKER_BUDGET_MS,
  STRIPE_WORKER_LIMITS,
  createStripeClient,
  firstChargeOn,
  readBillingEnv,
  runStripeCancellations,
  sendStripeCancel,
  stripeCancelIdempotencyKey,
  type BillingAlert,
  type StripeCancelJob,
  type StripeCancelOutcome,
  type StripeCancellationStore,
  type StripeClient,
} from "../src/billing/index.ts";
import { CheckoutCompletedError } from "../src/billing/upgrade.ts";
import { handleStripeWebhook, type BillingStore } from "../src/billing/webhook.ts";
import { stripeCancellationStore } from "../src/billing/cancel-store.ts";
import { billingStore, type PlatformDb } from "../src/stores.ts";

/**
 * Stopping a Stripe subscription (ADR 0161, migration 6140): the call is idempotent and never loses a failure, the worker
 * retries and alerts, and the webhook reconciles before it syncs. Stripe here is a fake; live keys are an owner step.
 */

const registry = loadPlanRegistry();

const IMMEDIATE: StripeCancelJob = {
  cancellationId: "c-1",
  stripeSubscriptionId: "sub_1",
  mode: "Immediately",
  attempt: 3,
};
const AT_END: StripeCancelJob = { ...IMMEDIATE, cancellationId: "c-2", mode: "At Period End" };

interface Call {
  readonly method: string;
  readonly id: string;
  readonly params?: unknown;
  readonly key?: string | undefined;
}

function fakeStripe(
  behavior: {
    cancel?: () => unknown;
    update?: () => unknown;
    retrieve?: () => unknown;
    expire?: () => unknown;
    sessionStatus?: string;
  } = {},
) {
  const calls: Call[] = [];
  const client = {
    subscriptions: {
      cancel: async (
        id: string,
        params: unknown,
        options: { idempotencyKey?: string } | undefined,
      ) => {
        calls.push({ method: "cancel", id, params, key: options?.idempotencyKey });
        return behavior.cancel ? behavior.cancel() : { status: "canceled" };
      },
      update: async (
        id: string,
        params: unknown,
        options: { idempotencyKey?: string } | undefined,
      ) => {
        calls.push({ method: "update", id, params, key: options?.idempotencyKey });
        return behavior.update ? behavior.update() : { status: "active" };
      },
      retrieve: async (id: string) => {
        calls.push({ method: "retrieve", id });
        return behavior.retrieve ? behavior.retrieve() : { status: "active" };
      },
    },
    checkout: {
      sessions: {
        retrieve: async (id: string) => {
          calls.push({ method: "session.retrieve", id });
          return { id, status: behavior.sessionStatus ?? "open" };
        },
        expire: async (id: string) => {
          calls.push({ method: "session.expire", id });
          return behavior.expire ? behavior.expire() : { id };
        },
      },
    },
  } as unknown as StripeClient;
  return { client, calls };
}

function stripeError(fields: { code?: string; type?: string; message?: string }): Error {
  return Object.assign(new Error(fields.message ?? "Stripe failed"), fields);
}

describe("sendStripeCancel", () => {
  it("cancels at once with no proration and no final invoice, under a key unique to the try", async () => {
    const stripe = fakeStripe();
    await expect(sendStripeCancel(stripe.client, IMMEDIATE)).resolves.toEqual({
      accepted: true,
      stripeStatus: "canceled",
    });
    expect(stripe.calls).toEqual([
      {
        method: "cancel",
        id: "sub_1",
        params: { prorate: false, invoice_now: false },
        key: "xos-stripe-cancel:c-1:3",
      },
    ]);
  });

  it("ends a plan at the end of its period, leaving the paid time running", async () => {
    const stripe = fakeStripe();
    await expect(sendStripeCancel(stripe.client, AT_END)).resolves.toEqual({
      accepted: true,
      stripeStatus: "active",
    });
    expect(stripe.calls[0]).toMatchObject({
      method: "update",
      params: { cancel_at_period_end: true },
    });
  });

  it("gives a retry its own idempotency key, since Stripe replays a stored failure under the same one", () => {
    expect(stripeCancelIdempotencyKey({ ...IMMEDIATE, attempt: 4 })).not.toBe(
      stripeCancelIdempotencyKey(IMMEDIATE),
    );
    expect(stripeCancelIdempotencyKey({ ...IMMEDIATE, attempt: "atlas" })).toBe(
      "xos-stripe-cancel:c-1:atlas",
    );
  });

  it("counts a subscription Stripe no longer has as accepted: it cannot charge", async () => {
    const stripe = fakeStripe({
      cancel: () => {
        throw stripeError({ code: "resource_missing" });
      },
    });
    await expect(sendStripeCancel(stripe.client, IMMEDIATE)).resolves.toEqual({
      accepted: true,
      stripeStatus: "missing",
    });
  });

  it("reads Stripe when it refuses the request: already canceled counts, anything else does not", async () => {
    const refused = () => {
      throw stripeError({ type: "StripeInvalidRequestError", message: "already canceled" });
    };
    await expect(
      sendStripeCancel(
        fakeStripe({ update: refused, retrieve: () => ({ status: "canceled" }) }).client,
        AT_END,
      ),
    ).resolves.toEqual({ accepted: true, stripeStatus: "canceled" });
    await expect(
      sendStripeCancel(
        fakeStripe({ update: refused, retrieve: () => ({ status: "incomplete_expired" }) }).client,
        { cancellationId: "c1", stripeSubscriptionId: "sub_1", mode: "At Period End", attempt: 1 },
      ),
    ).resolves.toEqual({ accepted: true, stripeStatus: "incomplete_expired" });
    await expect(
      sendStripeCancel(
        fakeStripe({ update: refused, retrieve: () => ({ status: "active" }) }).client,
        AT_END,
      ),
    ).resolves.toEqual({ accepted: false, error: "already canceled" });
    await expect(
      sendStripeCancel(
        fakeStripe({
          update: refused,
          retrieve: () => {
            throw stripeError({ code: "resource_missing" });
          },
        }).client,
        AT_END,
      ),
    ).resolves.toEqual({ accepted: true, stripeStatus: "missing" });
    await expect(
      sendStripeCancel(
        fakeStripe({
          update: refused,
          retrieve: () => {
            throw new Error("network");
          },
        }).client,
        AT_END,
      ),
    ).resolves.toEqual({ accepted: false, error: "already canceled" });
  });

  it("reports a Stripe outage as not accepted, never as done", async () => {
    const stripe = fakeStripe({
      cancel: () => {
        throw stripeError({ type: "StripeConnectionError", message: "connect ETIMEDOUT" });
      },
    });
    await expect(sendStripeCancel(stripe.client, IMMEDIATE)).resolves.toEqual({
      accepted: false,
      error: "connect ETIMEDOUT",
    });
    const nonError = fakeStripe({
      cancel: () => {
        throw "down";
      },
    });
    await expect(sendStripeCancel(nonError.client, IMMEDIATE)).resolves.toEqual({
      accepted: false,
      error: "down",
    });
  });
});

function memoryStore(
  jobs: readonly StripeCancelJob[],
  options: { sessions?: string[]; alerts?: BillingAlert[] } = {},
) {
  const finished: { cancellationId: string; outcome: StripeCancelOutcome }[] = [];
  const closed: string[] = [];
  const sent: string[] = [];
  const claims: unknown[] = [];
  const due = [...jobs];
  const store: StripeCancellationStore = {
    claim: async (input) => {
      claims.push(input);
      return due.splice(0, input.limit);
    },
    finish: async (input) => {
      finished.push(input);
    },
    checkoutsToClose: async () => options.sessions ?? [],
    closeCheckout: async (id) => {
      closed.push(id);
    },
    alertsToSend: async () => (options.alerts ?? []).filter((a) => !sent.includes(a.alertId)),
    markAlertSent: async (id) => {
      sent.push(id);
    },
  };
  return { store, finished, closed, sent, claims };
}

const ALERT: BillingAlert = {
  alertId: "a-1",
  kind: "cancel_delayed",
  orgId: "org-1",
  stripeSubscriptionId: "sub_1",
  detail: "Stripe has not accepted it.",
  raisedAt: "2026-11-06T00:00:00Z",
};

describe("runStripeCancellations", () => {
  it("sends what is due, records each answer and keeps going past a failure", async () => {
    const stripe = fakeStripe({
      cancel: () => {
        throw new Error("Stripe is down");
      },
    });
    const memory = memoryStore([IMMEDIATE, AT_END]);
    const run = await runStripeCancellations({
      stripe: stripe.client,
      store: memory.store,
      worker: "w",
      livemode: true,
      sink: null,
    });
    expect(run).toEqual({
      accepted: 1,
      failed: 1,
      checkoutsClosed: 0,
      alertsSent: 0,
      alertsWaiting: 0,
      outOfTime: false,
    });
    const claim = { worker: "w", livemode: true, limit: 1 };
    expect(memory.claims).toEqual([claim, claim, claim]);
    expect(memory.finished).toEqual([
      { cancellationId: "c-1", outcome: { accepted: false, error: "Stripe is down" } },
      { cancellationId: "c-2", outcome: { accepted: true, stripeStatus: "active" } },
    ]);
  });

  it("without a Stripe key claims nothing, so cancels stay queued, and still reports alerts", async () => {
    const memory = memoryStore([IMMEDIATE], { alerts: [ALERT] });
    const delivered: BillingAlert[] = [];
    const run = await runStripeCancellations({
      stripe: null,
      store: memory.store,
      worker: "w",
      livemode: false,
      sink: {
        send: async (alert) => {
          delivered.push(alert);
        },
      },
      limit: 5,
    });
    expect(memory.claims).toEqual([]);
    expect(run.alertsSent).toBe(1);
    expect(delivered).toEqual([ALERT]);
    expect(memory.sent).toEqual(["a-1"]);
  });

  it("leaves an alert unsent when there is nowhere to send it or the mail fails", async () => {
    const waiting = memoryStore([], { alerts: [ALERT] });
    await expect(
      runStripeCancellations({
        stripe: null,
        store: waiting.store,
        worker: "w",
        livemode: false,
        sink: null,
      }),
    ).resolves.toMatchObject({ alertsSent: 0, alertsWaiting: 1 });
    const failing = memoryStore([], { alerts: [ALERT] });
    await expect(
      runStripeCancellations({
        stripe: null,
        store: failing.store,
        worker: "w",
        livemode: false,
        sink: {
          send: async () => {
            throw new Error("no mail");
          },
        },
      }),
    ).resolves.toMatchObject({ alertsSent: 0, alertsWaiting: 1 });
    expect(failing.sent).toEqual([]);
  });

  it("sends open alerts before it calls Stripe, so an alert cannot clear unseen, and again for what the run raised", async () => {
    const order: string[] = [];
    const raised: BillingAlert = { ...ALERT, alertId: "a-2", kind: "cancel_delayed" };
    const stripe = fakeStripe({
      cancel: () => {
        order.push("stripe");
        throw new Error("down");
      },
    });
    const open = [{ ...ALERT, kind: "active_on_deleted_org" }];
    const memory = memoryStore([IMMEDIATE]);
    memory.store.alertsToSend = async () => open.splice(0);
    memory.store.finish = async () => {
      open.push(raised);
    };
    const run = await runStripeCancellations({
      stripe: stripe.client,
      store: memory.store,
      worker: "w",
      livemode: false,
      sink: {
        send: async (alert) => {
          order.push(alert.kind);
        },
      },
    });
    expect(order).toEqual(["active_on_deleted_org", "stripe", "cancel_delayed"]);
    expect(run).toMatchObject({ alertsSent: 2, alertsWaiting: 0, failed: 1 });
  });

  it("stops at its time budget with the rest still due and unclaimed, and still sends alerts", async () => {
    let time = 0;
    const clock = () => (time += 20_000);
    const jobs = ["c-1", "c-2", "c-3", "c-4"].map((id) => ({ ...IMMEDIATE, cancellationId: id }));
    const memory = memoryStore(jobs, { alerts: [ALERT], sessions: ["cs_test_1"] });
    const delivered: string[] = [];
    const run = await runStripeCancellations({
      stripe: fakeStripe().client,
      store: memory.store,
      worker: "w",
      livemode: false,
      sink: {
        send: async (alert) => {
          delivered.push(alert.alertId);
        },
      },
      clock,
      budgetMs: 45_000,
    });
    expect(run).toMatchObject({ accepted: 2, checkoutsClosed: 0, alertsSent: 1, outOfTime: true });
    expect(memory.finished.map((f) => f.cancellationId)).toEqual(["c-1", "c-2"]);
    expect(memory.claims).toHaveLength(2);
    expect(memory.closed).toEqual([]);
    expect(delivered).toEqual(["a-1"]);
  });

  it("gives the worker's Stripe client a short limit per call and no retries of its own", async () => {
    expect(STRIPE_WORKER_LIMITS.timeoutMs * 5).toBeLessThanOrEqual(STRIPE_WORKER_BUDGET_MS);
    const env = readBillingEnv({ STRIPE_SECRET_KEY: "sk_test_abcdefghij" });
    const limited = (await createStripeClient(env, undefined, STRIPE_WORKER_LIMITS)) as unknown as {
      getApiField: (key: string) => unknown;
      getMaxNetworkRetries: () => number;
    };
    expect(limited.getApiField("timeout")).toBe(STRIPE_WORKER_LIMITS.timeoutMs);
    expect(limited.getMaxNetworkRetries()).toBe(0);
    const plain = (await createStripeClient(env)) as unknown as {
      getMaxNetworkRetries: () => number;
    };
    expect(plain.getMaxNetworkRetries()).toBe(2);
  });

  it("counts a Stripe that never answers as a failure within the limit, rather than waiting on it", async () => {
    const sockets: Socket[] = [];
    const server = createServer(() => undefined);
    server.on("connection", (socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const env = readBillingEnv({
        STRIPE_SECRET_KEY: "sk_test_abcdefghij",
        STRIPE_API_URL: `http://127.0.0.1:${String(port)}`,
      });
      const client = await createStripeClient(env, undefined, {
        timeoutMs: 100,
        maxNetworkRetries: 0,
      });
      const started = Date.now();
      const outcome = await sendStripeCancel(client, IMMEDIATE);
      expect(outcome.accepted).toBe(false);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("expires Checkout sessions on an org that is ending, and leaves one just paid to reconciliation", async () => {
    const open = fakeStripe();
    const closing = memoryStore([], { sessions: ["cs_test_1"] });
    await expect(
      runStripeCancellations({
        stripe: open.client,
        store: closing.store,
        worker: "w",
        livemode: false,
        sink: null,
      }),
    ).resolves.toMatchObject({ checkoutsClosed: 1, failed: 0 });
    expect(closing.closed).toEqual(["cs_test_1"]);
    expect(open.calls.map((c) => c.method)).toEqual(["session.retrieve", "session.expire"]);

    const paid = memoryStore([], { sessions: ["cs_test_2"] });
    await expect(
      runStripeCancellations({
        stripe: fakeStripe({ sessionStatus: "complete" }).client,
        store: paid.store,
        worker: "w",
        livemode: false,
        sink: null,
      }),
    ).resolves.toMatchObject({ checkoutsClosed: 0, failed: 0 });
    expect(paid.closed).toEqual([]);
    expect(new CheckoutCompletedError("x")).toBeInstanceOf(Error);

    const broken = memoryStore([], { sessions: ["cs_test_3"] });
    const stripe = fakeStripe({
      expire: () => {
        throw new Error("down");
      },
    });
    (stripe.client.checkout.sessions.retrieve as unknown as (id: string) => Promise<unknown>) =
      async (id: string) => ({ id, status: "open" });
    await expect(
      runStripeCancellations({
        stripe: stripe.client,
        store: broken.store,
        worker: "w",
        livemode: false,
        sink: null,
      }),
    ).resolves.toMatchObject({ checkoutsClosed: 0, failed: 1 });
  });
});

describe("stripeCancellationStore", () => {
  it("maps the 6140 RPCs", async () => {
    const calls: { fn: string; args: unknown }[] = [];
    const answers: Record<string, unknown> = {
      claim_stripe_cancellations: [
        {
          cancellation_id: "c-1",
          stripe_subscription_id: "sub_1",
          cancel_mode: "Immediately",
          attempt: 2,
        },
      ],
      stripe_checkouts_to_close: [{ stripe_checkout_session_id: "cs_test_1" }],
      billing_alerts_to_send: [
        {
          alert_id: "a-1",
          alert_kind: "active_on_deleted_org",
          subject_org_id: null,
          stripe_subscription_id: "sub_1",
          detail: "x",
          raised_at: "t",
        },
      ],
    };
    const db: PlatformDb = {
      rpc: async (fn, args) => {
        calls.push({ fn, args });
        return answers[fn] ?? null;
      },
      selectOne: async () => null,
    };
    const store = stripeCancellationStore(db);
    await expect(store.claim({ worker: "w", livemode: true, limit: 3 })).resolves.toEqual([
      {
        cancellationId: "c-1",
        stripeSubscriptionId: "sub_1",
        mode: "Immediately",
        attempt: 2,
      },
    ]);
    await store.finish({
      cancellationId: "c-1",
      outcome: { accepted: true, stripeStatus: "canceled" },
    });
    await store.finish({ cancellationId: "c-1", outcome: { accepted: false, error: "down" } });
    await expect(store.checkoutsToClose(true)).resolves.toEqual(["cs_test_1"]);
    await store.closeCheckout("cs_test_1");
    await expect(store.alertsToSend()).resolves.toEqual([
      {
        alertId: "a-1",
        kind: "active_on_deleted_org",
        orgId: null,
        stripeSubscriptionId: "sub_1",
        detail: "x",
        raisedAt: "t",
      },
    ]);
    await store.markAlertSent("a-1");
    expect(calls.map((c) => c.fn)).toEqual([
      "claim_stripe_cancellations",
      "finish_stripe_cancellation",
      "finish_stripe_cancellation",
      "stripe_checkouts_to_close",
      "finish_billing_checkout_from_stripe",
      "billing_alerts_to_send",
      "mark_billing_alert_sent",
    ]);
    expect(calls[1]?.args).toEqual({
      p_id: "c-1",
      p_accepted: true,
      p_stripe_status: "canceled",
      p_error: null,
    });
    expect(calls[2]?.args).toEqual({
      p_id: "c-1",
      p_accepted: false,
      p_stripe_status: null,
      p_error: "down",
    });
    expect(billingStore).toBeTypeOf("function");
  });
});

describe("the renewal terms", () => {
  it("name a dated version, and fit Stripe's limit", () => {
    expect(RENEWAL_TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(CHECKOUT_MESSAGE_MAX).toBe(1200);
  });

  it("date the first charge today, or when the carried trial ends", () => {
    const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const now = new Date("2026-11-06T12:00:00Z");
    expect(firstChargeOn(undefined, dayOf, now)).toBe("2026-11-06");
    expect(firstChargeOn(Date.parse("2026-11-20T05:00:00Z") / 1000, dayOf, now)).toBe("2026-11-20");
  });
});

describe("handleStripeWebhook reconciliation", () => {
  const secret = `whsec_${randomBytes(12).toString("hex")}`;
  const sign = (body: string) =>
    Stripe.webhooks.generateTestHeaderString({ payload: body, secret });

  function memory(options: { reconcile?: string; failReconcile?: boolean; failCharge?: boolean }) {
    const log: string[] = [];
    const finished: (string | null)[] = [];
    const store: BillingStore = {
      recordStripeEvent: async () => ({ rowId: "row-1", isNew: true, processed: false }),
      finishStripeEvent: async (_, error) => {
        finished.push(error);
      },
      orgForCustomer: async () => null,
      syncSubscription: async () => {
        log.push("sync");
        return "active";
      },
      recordAddonPurchase: async () => "p",
      finishCheckout: async () => true,
      reconcileSubscription: async (input) => {
        log.push(`reconcile:${input.status}`);
        if (options.failReconcile) throw new Error("reconcile failed");
        return options.reconcile ?? "proceed";
      },
      noteSubscriptionTerms: async (input) => {
        log.push(
          `terms:${input.cancelAt?.toISOString() ?? "none"}:${String(input.amountMinor)}:${String(input.currency)}`,
        );
        return true;
      },
      noteCharge: async (input) => {
        log.push(`charge:${input.subscriptionId}:${String(input.amountMinor)}`);
        if (options.failCharge) throw new Error("charge failed");
        return true;
      },
    };
    return { store, log, finished };
  }

  function deliver(store: BillingStore, type: string, object: unknown) {
    const rawBody = JSON.stringify({
      id: "evt_1",
      object: "event",
      type,
      livemode: false,
      created: 1_790_000_000,
      api_version: "2026-09-30",
      data: { object },
    });
    return handleStripeWebhook({
      rawBody,
      signature: sign(rawBody),
      webhookSecret: secret,
      livemode: false,
      registry,
      store,
    });
  }

  const ORG = "00000000-0000-4000-8000-000000000001";
  const subscription = (fields: Record<string, unknown> = {}) => ({
    id: "sub_1",
    object: "subscription",
    customer: "cus_1",
    status: "active",
    metadata: { org_id: ORG },
    cancel_at: null,
    cancel_at_period_end: false,
    pause_collection: null,
    items: {
      data: [
        {
          id: "si_1",
          quantity: 1,
          current_period_end: 1_800_000_000,
          price: {
            id: "price_1",
            lookup_key: registry.plans.find((p) => p.stripe !== null)?.stripe
              ?.monthlyPriceLookupKey,
            unit_amount: 14900,
            currency: "usd",
          },
        },
      ],
    },
    ...fields,
  });

  it("reconciles first and never syncs a subscription on an org that is gone or ending", async () => {
    const m = memory({ reconcile: "queued" });
    await expect(
      deliver(m.store, "customer.subscription.updated", subscription()),
    ).resolves.toMatchObject({ outcome: "applied", state: "queued" });
    expect(m.log).toEqual(["reconcile:active"]);
    expect(m.finished).toEqual([null]);
  });

  it("reports the deleted event's status as canceled to reconciliation, and settles on ended", async () => {
    const m = memory({ reconcile: "ended" });
    await expect(
      deliver(m.store, "customer.subscription.deleted", subscription({ status: "active" })),
    ).resolves.toMatchObject({ outcome: "applied", state: "ended" });
    expect(m.log).toEqual(["reconcile:canceled"]);
  });

  it("retries when reconciliation fails, without touching the subscription", async () => {
    const m = memory({ failReconcile: true });
    await expect(
      deliver(m.store, "customer.subscription.updated", subscription()),
    ).resolves.toMatchObject({ outcome: "failed", error: "reconcile failed" });
    expect(m.finished).toEqual(["reconcile failed"]);
    expect(m.log).toEqual(["reconcile:active"]);
  });

  it("after the sync, notes when Stripe ends the subscription and what it charges", async () => {
    const atEnd = memory({});
    await deliver(
      atEnd.store,
      "customer.subscription.updated",
      subscription({ cancel_at_period_end: true }),
    );
    expect(atEnd.log).toEqual([
      "reconcile:active",
      "sync",
      `terms:${new Date(1_800_000_000_000).toISOString()}:14900:usd`,
    ]);
    const dated = memory({});
    await deliver(
      dated.store,
      "customer.subscription.updated",
      subscription({ cancel_at: 1_790_000_100 }),
    );
    expect(dated.log[2]).toBe(`terms:${new Date(1_790_000_100_000).toISOString()}:14900:usd`);
    const ended = memory({});
    await deliver(ended.store, "customer.subscription.deleted", subscription());
    expect(ended.log[2]).toBe("terms:none:14900:usd");
  });

  it("leaves the amount unset when a price does not say", async () => {
    const m = memory({});
    const lookupKey = registry.plans.find((p) => p.stripe !== null)?.stripe?.monthlyPriceLookupKey;
    await deliver(
      m.store,
      "customer.subscription.updated",
      subscription({
        items: {
          data: [
            { id: "si_1", quantity: 1, current_period_end: 1, price: { lookup_key: lookupKey } },
          ],
        },
      }),
    );
    expect(m.log[2]).toBe("terms:none:null:null");
  });

  it("notes what a subscriber in another currency pays, not the price's default currency", async () => {
    const plan = registry.plans.find((p) => p.stripe !== null);
    const seat = plan?.extraSeat;
    const item = (fields: Record<string, unknown>) => ({
      id: "si_1",
      quantity: 1,
      current_period_end: 1,
      ...fields,
    });
    const usdPrice = {
      lookup_key: plan?.stripe?.monthlyPriceLookupKey,
      unit_amount: plan?.prices.USD.monthlyMinor,
      currency: "usd",
    };
    const book = memory({});
    await deliver(
      book.store,
      "customer.subscription.updated",
      subscription({
        currency: "eur",
        items: {
          data: [
            item({ price: usdPrice }),
            item({
              quantity: 2,
              price: {
                lookup_key: seat?.monthlyPriceLookupKey,
                unit_amount: seat?.prices.USD.monthlyMinor,
                currency: "usd",
              },
            }),
          ],
        },
      }),
    );
    const total = (plan?.prices.EUR.monthlyMinor ?? 0) + 2 * (seat?.prices.EUR.monthlyMinor ?? 0);
    expect(book.log[2]).toBe(`terms:none:${String(total)}:eur`);

    const expanded = memory({});
    await deliver(
      expanded.store,
      "customer.subscription.updated",
      subscription({
        currency: "gbp",
        items: {
          data: [item({ price: { ...usdPrice, currency_options: { gbp: { unit_amount: 777 } } } })],
        },
      }),
    );
    expect(expanded.log[2]).toBe("terms:none:777:gbp");

    const unknown = memory({});
    await deliver(
      unknown.store,
      "customer.subscription.updated",
      subscription({ currency: "jpy", items: { data: [item({ price: usdPrice })] } }),
    );
    expect(unknown.log[2]).toBe("terms:none:null:jpy");
  });

  it("reconciles a subscription of any price, and then ignores one that sells no plan", async () => {
    const m = memory({});
    await expect(
      deliver(
        m.store,
        "customer.subscription.updated",
        subscription({
          items: {
            data: [
              {
                id: "si_1",
                quantity: 1,
                current_period_end: 1,
                price: { lookup_key: "something_else" },
              },
            ],
          },
        }),
      ),
    ).resolves.toMatchObject({ outcome: "ignored" });
    expect(m.log).toEqual(["reconcile:active"]);
  });

  it("notes a paid invoice by its subscription, in the pinned shape and the older one", async () => {
    const pinned = memory({});
    await expect(
      deliver(pinned.store, "invoice.paid", {
        id: "in_1",
        object: "invoice",
        customer: "cus_1",
        amount_paid: 14900,
        currency: "usd",
        billing_reason: "subscription_cycle",
        parent: {
          subscription_details: { subscription: "sub_1", metadata: { org_id: ORG } },
        },
      }),
    ).resolves.toMatchObject({ outcome: "applied", state: "charged_after_cancel" });
    expect(pinned.log).toEqual(["charge:sub_1:14900"]);
    const older = memory({});
    await deliver(older.store, "invoice.paid", {
      id: "in_2",
      object: "invoice",
      customer: { id: "cus_1" },
      amount_paid: 100,
      currency: "usd",
      billing_reason: null,
      subscription: { id: "sub_2" },
    });
    expect(older.log).toEqual(["charge:sub_2:100"]);
  });

  it("ignores an invoice with no subscription, and retries when noting a charge fails", async () => {
    const none = memory({});
    await expect(
      deliver(none.store, "invoice.paid", {
        id: "in_3",
        object: "invoice",
        customer: "cus_1",
        amount_paid: 100,
        currency: "usd",
        billing_reason: null,
      }),
    ).resolves.toMatchObject({ outcome: "ignored" });
    const failing = memory({ failCharge: true });
    await expect(
      deliver(failing.store, "invoice.paid", {
        id: "in_4",
        object: "invoice",
        customer: "cus_1",
        amount_paid: 100,
        currency: "usd",
        billing_reason: null,
        subscription: "sub_1",
      }),
    ).resolves.toMatchObject({ outcome: "failed", error: "charge failed" });
  });
});
