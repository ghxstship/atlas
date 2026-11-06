import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as PlatformBilling from "@xos/platform/billing";
import type { OrgContext } from "@/lib/shell/context";

/**
 * ADR 0161: Atlas asks Stripe to stop for the person waiting, without recording anything, and a page says only what Stripe
 * has said. A cancel the webhook has not settled reads as not confirmed unless Stripe itself says it stopped, so nobody is
 * told a charge ended when it may not have.
 */
const config = vi.hoisted(() => ({ key: "sk_test_abcdefghij" as string | undefined }));
const stripe = vi.hoisted(() => ({
  retrieve: vi.fn(),
  cancel: vi.fn(),
  update: vi.fn(),
  created: vi.fn(),
}));
const data = vi.hoisted(() => ({ cancellations: { ok: true, data: [] } as unknown }));
const logger = vi.hoisted(() => ({ error: vi.fn() }));
const ctx = vi.hoisted(
  () =>
    ({ org: { id: "org-1", slug: "n", name: "N" }, viewer: { db: {} } }) as unknown as OrgContext,
);

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  env: () => ({
    ATLAS_SITE_URL: "https://atlas.test",
    STRIPE_SECRET_KEY: config.key,
    STRIPE_API_URL: undefined,
  }),
}));
vi.mock("@/lib/observability", () => ({ observability: { logger } }));
vi.mock("@xos/platform/billing", async (importOriginal) => ({
  ...(await importOriginal<typeof PlatformBilling>()),
  createStripeClient: async () => {
    stripe.created();
    return { subscriptions: stripe };
  },
}));
vi.mock("@xos/data/billing", () => ({
  getStripeCancellations: async () => data.cancellations,
  beginBillingCheckout: vi.fn(),
  beginSubscriptionPause: vi.fn(),
  beginSubscriptionResume: vi.fn(),
  getBillingPortalCustomer: vi.fn(),
  recordBillingCheckout: vi.fn(),
  recordRenewalConsent: vi.fn(),
  recordSubscriptionPause: vi.fn(),
  recordSubscriptionResume: vi.fn(),
}));
const keys = (key: string, values?: Record<string, unknown>) =>
  values === undefined ? key : `${key}(${Object.values(values).join(",")})`;
vi.mock("next-intl/server", () => ({ getTranslations: async () => keys }));
vi.mock("@/lib/platform/format", () => ({ getFormatters: async () => ({ date: String }) }));
vi.mock("@/lib/shell/time-zone", () => ({ getOrgTimeZone: async () => "UTC" }));

const { askStripeToStopNow, stripeHasStopped } = await import("@/lib/billing/stop-stripe");
const { StripeCancellationNotice } =
  await import("@/components/settings/stripe-cancellation-notice");
const { InlineAlert } = await import("@/components/ui");

const QUEUED = {
  id: "c-1",
  stripeSubscriptionId: "sub_1",
  mode: "Immediately",
  state: "Queued",
  requestedAt: "2026-11-06T00:00:00Z",
  acceptedAt: null,
  endsAt: null,
};

type Node = { type: unknown; props: Record<string, unknown> };
function alerts(tree: unknown): { tone: unknown; title: unknown; body: unknown }[] {
  const root = tree as Node | null;
  if (root === null) return [];
  return ([root.props["children"]].flat() as Node[])
    .filter((n) => n.type === InlineAlert)
    .map((n) => ({ tone: n.props["tone"], title: n.props["title"], body: n.props["children"] }));
}

beforeEach(() => {
  config.key = "sk_test_abcdefghij";
  data.cancellations = { ok: true, data: [] };
  for (const fn of Object.values(stripe)) fn.mockReset();
  logger.error.mockReset();
});

describe("askStripeToStopNow", () => {
  it("does nothing without a key, or with nothing queued, or when the status cannot be read", async () => {
    config.key = undefined;
    data.cancellations = { ok: true, data: [QUEUED] };
    await askStripeToStopNow({} as never, "org-1");
    config.key = "sk_test_abcdefghij";
    data.cancellations = { ok: true, data: [{ ...QUEUED, state: "Accepted" }] };
    await askStripeToStopNow({} as never, "org-1");
    data.cancellations = { ok: false, error: { kind: "unexpected" } };
    await askStripeToStopNow({} as never, "org-1");
    expect(stripe.created).not.toHaveBeenCalled();
  });

  it("asks Stripe for each queued cancel, with the mode each one asked for", async () => {
    data.cancellations = {
      ok: true,
      data: [
        QUEUED,
        { ...QUEUED, id: "c-2", stripeSubscriptionId: "sub_2", mode: "At Period End" },
      ],
    };
    stripe.cancel.mockResolvedValue({ status: "canceled" });
    stripe.update.mockResolvedValue({ status: "active" });
    await askStripeToStopNow({} as never, "org-1");
    expect(stripe.cancel.mock.calls[0]?.[0]).toBe("sub_1");
    expect(stripe.cancel.mock.calls[0]?.[2]).toEqual({
      idempotencyKey: "xos-stripe-cancel:c-1:atlas",
    });
    expect(stripe.update.mock.calls[0]?.[0]).toBe("sub_2");
  });

  it("never fails the action when Stripe is down: the worker retries", async () => {
    data.cancellations = { ok: true, data: [QUEUED] };
    stripe.cancel.mockRejectedValue(new Error("connect ETIMEDOUT"));
    await expect(askStripeToStopNow({} as never, "org-1")).resolves.toBeUndefined();
  });
});

describe("stripeHasStopped", () => {
  it("is what Stripe says, and any doubt is false", async () => {
    stripe.retrieve.mockResolvedValueOnce({ status: "canceled" });
    expect(await stripeHasStopped("sub_1", "Immediately")).toBe(true);
    stripe.retrieve.mockResolvedValueOnce({ status: "active" });
    expect(await stripeHasStopped("sub_1", "Immediately")).toBe(false);
    stripe.retrieve.mockResolvedValueOnce({ cancel_at_period_end: true, cancel_at: 1 });
    expect(await stripeHasStopped("sub_1", "At Period End")).toBe(true);
    stripe.retrieve.mockResolvedValueOnce({ cancel_at_period_end: false, cancel_at: null });
    expect(await stripeHasStopped("sub_1", "At Period End")).toBe(false);
    stripe.retrieve.mockRejectedValueOnce(new Error("down"));
    expect(await stripeHasStopped("sub_1", "Immediately")).toBe(false);
    config.key = undefined;
    expect(await stripeHasStopped("sub_1", "Immediately")).toBe(false);
  });
});

describe("StripeCancellationNotice", () => {
  it("shows nothing without a cancel, or when the status cannot be read", async () => {
    expect(await StripeCancellationNotice({ ctx })).toBeNull();
    data.cancellations = { ok: false, error: { kind: "unexpected" } };
    expect(await StripeCancellationNotice({ ctx })).toBeNull();
  });

  it("says not confirmed while Stripe has not accepted it, and never claims otherwise", async () => {
    data.cancellations = { ok: true, data: [QUEUED] };
    stripe.retrieve.mockRejectedValue(new Error("down"));
    expect(alerts(await StripeCancellationNotice({ ctx }))).toEqual([
      { tone: "warning", title: "queuedTitle", body: "queuedBody" },
    ]);
  });

  it("says accepted once it is recorded, or once Stripe itself says so", async () => {
    data.cancellations = { ok: true, data: [{ ...QUEUED, state: "Accepted" }] };
    expect(alerts(await StripeCancellationNotice({ ctx }))).toEqual([
      { tone: "success", title: "acceptedTitle", body: "acceptedBody" },
    ]);
    expect(stripe.retrieve).not.toHaveBeenCalled();
    data.cancellations = { ok: true, data: [QUEUED] };
    stripe.retrieve.mockResolvedValue({ status: "canceled" });
    expect(alerts(await StripeCancellationNotice({ ctx }))[0]?.tone).toBe("success");
  });

  it("gives the date a plan ends, or says when it ends without one", async () => {
    data.cancellations = {
      ok: true,
      data: [
        { ...QUEUED, mode: "At Period End", state: "Accepted", endsAt: "2026-12-01T12:00:00Z" },
      ],
    };
    expect(alerts(await StripeCancellationNotice({ ctx }))).toEqual([
      { tone: "info", title: "endingTitle", body: "endingBody(2026-12-01)" },
    ]);
    data.cancellations = {
      ok: true,
      data: [{ ...QUEUED, mode: "At Period End", state: "Accepted", endsAt: null }],
    };
    expect(alerts(await StripeCancellationNotice({ ctx }))[0]?.body).toBe("endingBodyNoDate");
  });
});
