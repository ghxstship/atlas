import type { Result, Subscription } from "@xos/data";

/**
 * The org's subscription as a page shows it. app.subscriptions keeps no row that is not canceled for an org whose
 * Owner canceled it (or that never subscribed), and getSubscription answers not-found for that: the org is on the
 * Access plan, as planHasFeature already reads it (lib/crew/plan.ts). Any other failure still throws.
 */
export function subscriptionOrAccess(result: Result<Subscription>): {
  readonly subscription: Subscription;
  /** True when no subscription is in force, so the org is on Access. */
  readonly none: boolean;
} {
  if (result.ok) return { subscription: result.data, none: false };
  if (result.error.kind === "not-found") {
    return { subscription: { planCode: "access", state: "none", trialEndsAt: null }, none: true };
  }
  throw new Error(`Cannot read the subscription: ${JSON.stringify(result.error)}`);
}

/** How the seat line reads: unlimited, within the limit, or over it ("2 seats in use; the plan includes 1"). */
export function seatUsageKey(usage: {
  readonly used: number;
  readonly limit: number | null;
}): "seatUsageUnlimited" | "seatUsage" | "seatUsageOver" {
  if (usage.limit === null) return "seatUsageUnlimited";
  return usage.used > usage.limit ? "seatUsageOver" : "seatUsage";
}
