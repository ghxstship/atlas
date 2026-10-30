import { describe, expect, it } from "vitest";
import {
  PauseRefusedError,
  pauseRefusal,
  pauseSubscription,
  resumeSubscription,
  stripeResumesAt,
  type PauseAccountStore,
  type StripeClient,
} from "../src/billing/index.ts";

/** B16 (ADR 0155 D4, migration 3051): the database's checks around Stripe's pause_collection. */

const NOW = new Date("2026-10-30T12:00:00Z");
const RESUMES = "2027-01-15T00:00:00.000Z";

interface Call {
  readonly method: string;
  readonly args: unknown;
}

function stripe(subscription: Record<string, unknown>, options: { resumeFails?: unknown } = {}) {
  const calls: Call[] = [];
  const client = {
    subscriptions: {
      retrieve: async (id: string) => {
        calls.push({ method: "retrieve", args: id });
        return { id, ...subscription };
      },
      update: async (id: string, params: unknown) => {
        calls.push({ method: "update", args: { id, params } });
        return { id };
      },
      resume: async (id: string, params: unknown) => {
        calls.push({ method: "resume", args: { id, params } });
        if (options.resumeFails !== undefined) throw options.resumeFails;
        return { id };
      },
    },
  } as unknown as StripeClient;
  return { client, calls };
}

function store(options: { started?: boolean; refuse?: string } = {}) {
  const calls: Call[] = [];
  const s: PauseAccountStore = {
    async begin(input) {
      calls.push({ method: "begin", args: input });
      if (options.refuse) throw new Error(options.refuse);
      return {
        stripeSubscriptionId: "sub_1",
        startsAt: "2026-11-15T00:00:00.000Z",
        resumesAt: RESUMES,
      };
    },
    async record(input) {
      calls.push({ method: "record", args: input });
      return "pause-1";
    },
    async beginResume(input) {
      calls.push({ method: "beginResume", args: input });
      if (options.refuse) throw new Error(options.refuse);
      return { stripeSubscriptionId: "sub_1", started: options.started ?? false };
    },
    async recordResume(input) {
      calls.push({ method: "recordResume", args: input });
      return "pause-1";
    },
  };
  return { store: s, calls };
}

const monthly = {
  status: "active",
  trial_end: null,
  pause_collection: null,
  items: { data: [{ price: { recurring: { interval: "month" } } }] },
};

describe("pausing", () => {
  it("checks the database, reads Stripe, pauses with void an hour before the XOS resume, then records", async () => {
    const s = stripe(monthly);
    const db = store();
    const result = await pauseSubscription(s.client, db.store, {
      orgId: "org-1",
      months: 2,
      livemode: false,
      now: NOW,
    });
    expect(result).toEqual({
      pauseId: "pause-1",
      startsAt: "2026-11-15T00:00:00.000Z",
      resumesAt: RESUMES,
    });
    expect(db.calls.map((c) => c.method)).toEqual(["begin", "record"]);
    expect(s.calls).toEqual([
      { method: "retrieve", args: "sub_1" },
      {
        method: "update",
        args: {
          id: "sub_1",
          params: {
            pause_collection: { behavior: "void", resumes_at: Date.parse(RESUMES) / 1000 - 3600 },
          },
        },
      },
    ]);
    expect(stripeResumesAt(RESUMES)).toBe(Date.parse(RESUMES) / 1000 - 3600);
    expect(db.calls[1]?.args).toEqual({
      orgId: "org-1",
      months: 2,
      livemode: false,
      stripeSubscriptionId: "sub_1",
    });
  });

  it("calls Stripe only after the database's checks pass", async () => {
    const s = stripe(monthly);
    const db = store({ refuse: "step_up_required: Confirm it is you." });
    await expect(
      pauseSubscription(s.client, db.store, { orgId: "org-1", months: 2, livemode: false }),
    ).rejects.toThrow(/step_up_required/);
    expect(s.calls).toEqual([]);
  });

  it.each([
    [{ ...monthly, trial_end: Date.parse("2026-11-01T00:00:00Z") / 1000 }, "pause_trial"],
    [{ ...monthly, status: "past_due" }, "pause_not_active"],
    [{ ...monthly, pause_collection: { behavior: "void" } }, "pause_open"],
    [
      { ...monthly, items: { data: [{ price: { recurring: { interval: "year" } } }] } },
      "pause_annual",
    ],
  ])("refuses %o as %s without changing Stripe", async (subscription, rule) => {
    const s = stripe(subscription);
    const db = store();
    const error = await pauseSubscription(s.client, db.store, {
      orgId: "org-1",
      months: 2,
      livemode: false,
      now: NOW,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PauseRefusedError);
    expect((error as PauseRefusedError).rule).toBe(rule);
    expect(s.calls.map((c) => c.method)).toEqual(["retrieve"]);
    expect(db.calls.map((c) => c.method)).toEqual(["begin"]);
  });

  it("lets a past trial pause", () => {
    expect(
      pauseRefusal({ ...monthly, trial_end: Date.parse("2026-10-01T00:00:00Z") / 1000 }, NOW),
    ).toBeNull();
  });
});

describe("resuming", () => {
  it("before the pause starts only clears pause_collection", async () => {
    const s = stripe({ ...monthly, pause_collection: { behavior: "void" } });
    const db = store({ started: false });
    await expect(
      resumeSubscription(s.client, db.store, { orgId: "org-1", livemode: false }),
    ).resolves.toEqual({ pauseId: "pause-1", started: false });
    expect(s.calls[1]).toEqual({
      method: "update",
      args: { id: "sub_1", params: { pause_collection: "" } },
    });
    expect(db.calls.map((c) => c.method)).toEqual(["beginResume", "recordResume"]);
  });

  it("after it starts begins a new period today with no proration", async () => {
    const s = stripe({ ...monthly, pause_collection: { behavior: "void" } });
    const db = store({ started: true });
    await resumeSubscription(s.client, db.store, { orgId: "org-1", livemode: false });
    expect(s.calls[1]).toEqual({
      method: "update",
      args: {
        id: "sub_1",
        params: {
          pause_collection: "",
          billing_cycle_anchor: { type: "now" },
          proration_behavior: "none",
        },
      },
    });
  });

  it("resumes a paused status with a new period, and asks for a card when Stripe needs one", async () => {
    const s = stripe({ ...monthly, status: "paused" });
    const db = store({ started: true });
    await resumeSubscription(s.client, db.store, { orgId: "org-1", livemode: false });
    expect(s.calls[1]).toEqual({
      method: "resume",
      args: { id: "sub_1", params: { billing_cycle_anchor: { type: "now" } } },
    });
    const noCard = stripe(
      { ...monthly, status: "paused" },
      { resumeFails: { code: "payment_method_required", message: "No payment method." } },
    );
    const error = await resumeSubscription(noCard.client, store().store, {
      orgId: "org-1",
      livemode: false,
    }).catch((e: unknown) => e);
    expect((error as PauseRefusedError).rule).toBe("pause_needs_payment_method");
  });

  it("calls Stripe only after the database's checks pass", async () => {
    const s = stripe(monthly);
    await expect(
      resumeSubscription(s.client, store({ refuse: "pause_none: No pause." }).store, {
        orgId: "org-1",
        livemode: false,
      }),
    ).rejects.toThrow(/pause_none/);
    expect(s.calls).toEqual([]);
  });
});
