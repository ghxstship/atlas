import type { PlanRegistry } from "@xos/schemas/plans";

/** Billing terms, matching app.billing_interval. */
export type BillingInterval = "Monthly" | "Annual";

export interface StripePlanMatch {
  readonly planCode: string;
  readonly interval: BillingInterval;
}

/**
 * The plan and term a Stripe price lookup key sells, read from packages/schemas/plans.yaml (ADR 0018).
 * Null when no plan uses the key, for example a per-project price the platform does not sell.
 */
export function planForLookupKey(
  registry: PlanRegistry,
  lookupKey: string | null | undefined,
): StripePlanMatch | null {
  if (lookupKey === null || lookupKey === undefined) return null;
  for (const plan of registry.plans) {
    if (plan.stripe === null) continue;
    if (plan.stripe.monthlyPriceLookupKey === lookupKey)
      return { planCode: plan.code, interval: "Monthly" };
    if (plan.stripe.annualPriceLookupKey === lookupKey)
      return { planCode: plan.code, interval: "Annual" };
  }
  return null;
}

/** The price lookup key of a paid plan and term. Throws for the free plan or an unknown plan. */
export function lookupKeyFor(
  registry: PlanRegistry,
  planCode: string,
  interval: BillingInterval,
): string {
  const plan = registry.plans.find((p) => p.code === planCode);
  if (plan === undefined) throw new Error(`Unknown plan ${planCode}`);
  if (plan.stripe === null) throw new Error(`The ${planCode} plan is free and has no Stripe price`);
  return interval === "Monthly"
    ? plan.stripe.monthlyPriceLookupKey
    : plan.stripe.annualPriceLookupKey;
}
