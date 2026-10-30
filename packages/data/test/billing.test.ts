import { describe, expect, it } from "vitest";
import {
  beginBillingCheckout,
  beginSubscriptionPause,
  beginSubscriptionResume,
  getBillingAccount,
  getBillingPortalCustomer,
  getSubscriptionPause,
  recordBillingCheckout,
  recordSubscriptionPause,
  recordSubscriptionResume,
} from "../src/billing.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/** Decision 21 (migration 1640): the billing repository passes the RPC arguments and maps rows and refusals. */

const org = "0192a000-0000-7000-8000-0000000000a1";

describe("billing checkout", () => {
  it("passes the checks' answer through, with nulls for an org that never paid and has no trial", async () => {
    const { db, calls } = fakeClient({
      "rpc:begin_billing_checkout": [
        okResponse([{ stripe_customer_id: null, trial_ends_at: null, open_session_ids: [] }]),
        okResponse([
          {
            stripe_customer_id: "cus_N1na",
            trial_ends_at: "2026-11-05T05:00:00+00:00",
            open_session_ids: ["cs_test_A"],
          },
        ]),
      ],
    });
    await expect(
      beginBillingCheckout(db, { orgId: org, planCode: "core", livemode: false }),
    ).resolves.toEqual({
      ok: true,
      data: { customerId: null, trialEndsAt: null, openSessionIds: [] },
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_org_id: org, p_plan_code: "core", p_livemode: false }],
    ]);
    await expect(
      beginBillingCheckout(db, { orgId: org, planCode: "pro", livemode: false }),
    ).resolves.toEqual({
      ok: true,
      data: {
        customerId: "cus_N1na",
        trialEndsAt: "2026-11-05T05:00:00+00:00",
        openSessionIds: ["cs_test_A"],
      },
    });
  });

  it("returns a refusal with its rule, such as step-up", async () => {
    const { db } = fakeClient({
      "rpc:begin_billing_checkout": [
        errorResponse(
          "XR001",
          "step_up_required: Confirm it is you with your second factor to change billing.",
          "step_up_required",
        ),
      ],
    });
    const result = await beginBillingCheckout(db, {
      orgId: org,
      planCode: "core",
      livemode: false,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "step_up_required" },
    });
  });

  it("records a session and returns the open ones it closed", async () => {
    const { db, calls } = fakeClient({
      "rpc:record_billing_checkout": [okResponse(["cs_test_Old"])],
    });
    await expect(
      recordBillingCheckout(db, {
        orgId: org,
        planCode: "team",
        interval: "Annual",
        sessionId: "cs_test_New",
        livemode: false,
        expiresAt: new Date("2026-10-24T12:00:00Z"),
      }),
    ).resolves.toEqual({ ok: true, data: ["cs_test_Old"] });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [
        {
          p_org_id: org,
          p_plan_code: "team",
          p_billing_interval: "Annual",
          p_stripe_checkout_session_id: "cs_test_New",
          p_livemode: false,
          p_expires_at: "2026-10-24T12:00:00.000Z",
        },
      ],
    ]);
  });
});

describe("billing portal and summary", () => {
  it("reads the portal customer, or the refusal for an org that never paid", async () => {
    const { db } = fakeClient({
      "rpc:billing_portal_customer": [
        okResponse("cus_N1na"),
        errorResponse(
          "XR001",
          "billing_no_customer: This organization has not paid through Stripe yet. Choose a plan first.",
          "billing_no_customer",
        ),
      ],
    });
    await expect(getBillingPortalCustomer(db, { orgId: org, livemode: false })).resolves.toEqual({
      ok: true,
      data: "cus_N1na",
    });
    await expect(
      getBillingPortalCustomer(db, { orgId: org, livemode: false }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "billing_no_customer" },
    });
  });

  it("maps the billing summary: paid, or paid and waiting for the subscription to sync", async () => {
    const { db } = fakeClient({
      "rpc:billing_account": [
        okResponse([
          {
            paid_through_stripe: true,
            has_stripe_customer: true,
            awaiting_subscription: false,
            billing_interval: "Annual",
            current_period_end: "2027-10-23T12:00:00+00:00",
          },
        ]),
        okResponse([
          {
            paid_through_stripe: false,
            has_stripe_customer: false,
            awaiting_subscription: true,
            billing_interval: null,
            current_period_end: null,
          },
        ]),
      ],
    });
    await expect(getBillingAccount(db, org, false)).resolves.toEqual({
      ok: true,
      data: {
        paidThroughStripe: true,
        hasStripeCustomer: true,
        awaitingSubscription: false,
        interval: "Annual",
        currentPeriodEnd: "2027-10-23T12:00:00+00:00",
      },
    });
    await expect(getBillingAccount(db, org, false)).resolves.toEqual({
      ok: true,
      data: {
        paidThroughStripe: false,
        hasStripeCustomer: false,
        awaitingSubscription: true,
        interval: null,
        currentPeriodEnd: null,
      },
    });
  });
});

describe("subscription pause (B16, 3051)", () => {
  it("begins and records a pause, and begins and records a resume", async () => {
    const { db, calls } = fakeClient({
      "rpc:begin_subscription_pause": [
        okResponse([
          {
            stripe_subscription_id: "sub_1",
            starts_at: "2026-11-15T00:00:00Z",
            resumes_at: "2027-01-15T00:00:00Z",
          },
        ]),
        errorResponse(
          "XR001",
          "pause_annual: An annual plan is paid for the year and cannot pause.",
        ),
        okResponse([]),
      ],
      "rpc:record_subscription_pause": [okResponse("pause-1")],
      "rpc:begin_subscription_resume": [
        okResponse([{ stripe_subscription_id: "sub_1", started: true }]),
        okResponse([]),
      ],
      "rpc:record_subscription_resume": [okResponse("pause-1")],
    });
    expect(await beginSubscriptionPause(db, { orgId: org, months: 2, livemode: false })).toEqual({
      ok: true,
      data: {
        stripeSubscriptionId: "sub_1",
        startsAt: "2026-11-15T00:00:00Z",
        resumesAt: "2027-01-15T00:00:00Z",
      },
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_org_id: org, p_months: 2, p_livemode: false }],
    ]);
    const annual = await beginSubscriptionPause(db, { orgId: org, months: 2, livemode: false });
    expect(annual.ok === false && annual.error).toMatchObject({
      kind: "refusal",
      rule: "pause_annual",
    });
    expect((await beginSubscriptionPause(db, { orgId: org, months: 2, livemode: false })).ok).toBe(
      false,
    );
    expect(
      await recordSubscriptionPause(db, {
        orgId: org,
        months: 2,
        livemode: false,
        stripeSubscriptionId: "sub_1",
      }),
    ).toEqual({ ok: true, data: "pause-1" });
    expect(await beginSubscriptionResume(db, { orgId: org, livemode: false })).toEqual({
      ok: true,
      data: { stripeSubscriptionId: "sub_1", started: true },
    });
    expect((await beginSubscriptionResume(db, { orgId: org, livemode: false })).ok).toBe(false);
    expect(await recordSubscriptionResume(db, { orgId: org, livemode: false })).toEqual({
      ok: true,
      data: "pause-1",
    });
  });

  it("reads the open pause, or none", async () => {
    const { db } = fakeClient({
      "rpc:subscription_pause_status": [
        okResponse([
          {
            pause_id: "p1",
            source: "Stripe",
            months: null,
            starts_at: "2026-10-01T00:00:00Z",
            resumes_at: null,
            started: true,
          },
        ]),
        okResponse([]),
      ],
    });
    expect(await getSubscriptionPause(db, org)).toEqual({
      ok: true,
      data: {
        pauseId: "p1",
        source: "Stripe",
        months: null,
        startsAt: "2026-10-01T00:00:00Z",
        resumesAt: null,
        started: true,
      },
    });
    expect(await getSubscriptionPause(db, org)).toEqual({ ok: true, data: null });
  });
});
