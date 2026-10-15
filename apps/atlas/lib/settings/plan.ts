import { PLANS } from "@/lib/plans.generated";

/**
 * Whether a plan includes a feature, following each plan's `extends` chain in the generated plan
 * summaries (Section 16). Pages use it to explain a refusal before the person meets it; the
 * database checks the plan again on every write.
 */
export function planHasFeature(planCode: string, feature: string): boolean {
  const seen = new Set<string>();
  let code: string | null = planCode;
  while (code !== null && !seen.has(code)) {
    seen.add(code);
    const plan = PLANS.find((p) => p.code === code);
    if (!plan) return false;
    if (plan.adds.includes(feature)) return true;
    code = plan.extends;
  }
  return false;
}
