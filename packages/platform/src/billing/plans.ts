import type { AddonDefinition, PlanRegistry } from "@xos/schemas/plans";

/** Billing terms, matching app.billing_interval. */
export type BillingInterval = "Monthly" | "Annual";

export interface StripePlanMatch {
  readonly planCode: string;
  readonly interval: BillingInterval;
}

/**
 * The plan and term a Stripe price lookup key sells, read from packages/schemas/plans.yaml (ADR 0018).
 * Null when no plan uses the key, for example a v3 price the platform no longer sells.
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

/** The plan and term an extra-seat price lookup key belongs to (ADR 0035), or null. */
export function extraSeatForLookupKey(
  registry: PlanRegistry,
  lookupKey: string | null | undefined,
): StripePlanMatch | null {
  if (lookupKey === null || lookupKey === undefined) return null;
  for (const plan of registry.plans) {
    if (plan.extraSeat === null) continue;
    if (plan.extraSeat.monthlyPriceLookupKey === lookupKey)
      return { planCode: plan.code, interval: "Monthly" };
    if (plan.extraSeat.annualPriceLookupKey === lookupKey)
      return { planCode: plan.code, interval: "Annual" };
  }
  return null;
}

/** The one-time add-on a price lookup key sells (ADR 0035), or null. */
export function addonForLookupKey(
  registry: PlanRegistry,
  lookupKey: string | null | undefined,
): AddonDefinition | null {
  if (lookupKey === null || lookupKey === undefined) return null;
  return registry.addons.find((a) => a.priceLookupKey === lookupKey) ?? null;
}

/** A plan that cannot be bought through Stripe Checkout: the free plan or a plan sold by quote. */
export class NotSelfServeError extends Error {
  readonly planCode: string;
  constructor(planCode: string, reason: "free" | "quote") {
    super(
      reason === "free"
        ? `The ${planCode} plan is free and has no Stripe price`
        : `The ${planCode} plan is sold by quote on an annual contract, never through checkout`,
    );
    this.name = "NotSelfServeError";
    this.planCode = planCode;
  }
}

function selfServePlan(registry: PlanRegistry, planCode: string) {
  const plan = registry.plans.find((p) => p.code === planCode);
  if (plan === undefined) throw new Error(`Unknown plan ${planCode}`);
  if (plan.stripe === null) throw new NotSelfServeError(planCode, plan.free ? "free" : "quote");
  return { plan, stripe: plan.stripe };
}

/** The price lookup key of a self-serve plan and term. Throws for the free plan, a quoted plan or an unknown plan. */
export function lookupKeyFor(
  registry: PlanRegistry,
  planCode: string,
  interval: BillingInterval,
): string {
  const { stripe } = selfServePlan(registry, planCode);
  return interval === "Monthly" ? stripe.monthlyPriceLookupKey : stripe.annualPriceLookupKey;
}

/** The extra-seat price lookup key of a plan and term. Throws when the plan sells no extra seats. */
export function extraSeatLookupKeyFor(
  registry: PlanRegistry,
  planCode: string,
  interval: BillingInterval,
): string {
  const { plan } = selfServePlan(registry, planCode);
  if (plan.extraSeat === null) throw new Error(`The ${planCode} plan sells no extra seats`);
  return interval === "Monthly"
    ? plan.extraSeat.monthlyPriceLookupKey
    : plan.extraSeat.annualPriceLookupKey;
}
