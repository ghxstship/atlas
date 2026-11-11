import { describe, expect, it } from "vitest";
import { seatUsageKey, subscriptionOrAccess } from "@/lib/billing/current-subscription";
import { planFeatures } from "@/lib/crew/plan";

/**
 * Billing and Plan after the Owner cancels the org (crawl 4.9): getSubscription finds no subscription that is not
 * canceled and answers not-found. The page reads that as the Access plan, as planHasFeature does, instead of
 * throwing "Cannot read the subscription: not-found" and answering 500. An org over its seats says so in words.
 */
describe("subscriptionOrAccess", () => {
  it("reads a canceled org (not-found) as the Access plan", () => {
    const read = subscriptionOrAccess({ ok: false, error: { kind: "not-found" } });
    expect(read.none).toBe(true);
    expect(read.subscription).toEqual({ planCode: "access", state: "none", trialEndsAt: null });
    expect(planFeatures(read.subscription.planCode)).toEqual(planFeatures("access"));
  });

  it("passes a subscription in force through", () => {
    const data = { planCode: "core", state: "active", trialEndsAt: null };
    expect(subscriptionOrAccess({ ok: true, data })).toEqual({ subscription: data, none: false });
  });

  it("still fails on any other error", () => {
    expect(() =>
      subscriptionOrAccess({ ok: false, error: { kind: "unexpected", message: "boom" } }),
    ).toThrow(/Cannot read the subscription/);
  });
});

describe("seatUsageKey", () => {
  it("never reads 2 of 1 seats in use", () => {
    expect(seatUsageKey({ used: 2, limit: 1 })).toBe("seatUsageOver");
    expect(seatUsageKey({ used: 1, limit: 1 })).toBe("seatUsage");
    expect(seatUsageKey({ used: 9, limit: null })).toBe("seatUsageUnlimited");
  });
});
