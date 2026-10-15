import { getSubscription } from "@xos/data";
import { PLANS } from "@/lib/plans.generated";
import type { OrgContext } from "@/lib/shell/context";

/**
 * Plan features from packages/schemas/plans.yaml (Section 16), resolved through `extends`. The UI uses
 * this to explain an upgrade before the database refuses; SQL still enforces the gate (migration 0461).
 */
export function planFeatures(planCode: string): ReadonlySet<string> {
  const features = new Set<string>();
  let code: string | null = planCode;
  const seen = new Set<string>();
  while (code !== null && !seen.has(code)) {
    seen.add(code);
    const plan = PLANS.find((p) => p.code === code);
    if (!plan) break;
    for (const f of plan.adds) features.add(f);
    code = plan.extends;
  }
  return features;
}

/** Whether the org's current plan includes a feature; an org without a subscription is on Access. */
export async function planHasFeature(ctx: OrgContext, feature: string): Promise<boolean> {
  const subscription = await getSubscription(ctx.viewer.db, ctx.org.id);
  if (!subscription.ok && subscription.error.kind !== "not-found") {
    throw new Error(`Cannot read the subscription: ${subscription.error.kind}`);
  }
  return planFeatures(subscription.ok ? subscription.data.planCode : "access").has(feature);
}
