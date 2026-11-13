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

/**
 * Why members' personal tokens work or not (app.org_allows_personal_tokens needs both developer.personal_tokens and
 * the api_keys plan feature): on, off by the setting, or off because the plan has no API access. A plan that dropped
 * API access must never tell the Owner to turn on a setting that is already on (crawl 4.9).
 */
export function personalTokensState(
  allowed: boolean,
  planIncludesApi: boolean,
): "orgOn" | "orgOff" | "orgPlanOff" {
  if (allowed) return "orgOn";
  return planIncludesApi ? "orgOff" : "orgPlanOff";
}
