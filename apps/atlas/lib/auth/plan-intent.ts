import { PLANS } from "@/lib/plans.generated";

/**
 * The plan a buyer chose before they had an account (docs/sign-up-links.md). The marketing site's plan buttons link to
 * /auth/sign-up?plan=<code>, and the new Owner is shown that plan on Billing and Plan once the organization exists.
 *
 * The intent is a display hint and nothing else. It rides inside `next`, the address a person continues to after signing
 * in, so it needs no cookie and no stored state, and it survives an email confirmation opened in another browser exactly
 * as `next` does. It never reaches a billing action: Checkout opens only from the renewal terms the Owner agrees to
 * (ADR 0161), and nothing here changes a plan, a trial or a charge.
 */
export const PLAN_INTENT_PARAM = "plan";

/** A person's organization, as far as the intent needs it. */
interface OwnedOrg {
  readonly slug: string;
  readonly roles: readonly { readonly code: string }[];
}

/**
 * The plan code a request names, or null. Only a plan packages/schemas/plans.yaml sells by self-serve Checkout counts
 * (Core, Pro and Team today): the free plan, a plan sold by quote, an unknown code, a different case, a repeated
 * parameter and anything that is not a string are dropped without a message. The code returned is the registry's own
 * string, so nothing a visitor typed is ever written into a page or an address.
 */
export function planIntent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return PLANS.find((plan) => plan.selfServe && plan.code === value)?.code ?? null;
}

/** The entry page carrying an intent: where a sign-up or sign-in that names a plan continues to. */
export function planIntentEntry(code: string): string {
  return `/?${PLAN_INTENT_PARAM}=${code}`;
}

/**
 * The plan a `next` carries, or null: the code when the path is exactly the entry page with one self-serve plan. A page
 * that was handed the plan only inside `next` (the sign-in page's link to sign-up, and back) reads it with this, so the
 * plan is named there too. The code returned is the registry's own string.
 */
export function planIntentOfEntry(next: string): string | null {
  return PLANS.find((plan) => plan.selfServe && planIntentEntry(plan.code) === next)?.code ?? null;
}

/** The sign-up address that names a plan, as docs/sign-up-links.md documents it. */
export function signUpPlanPath(code: string): string {
  return `/auth/sign-up?${PLAN_INTENT_PARAM}=${code}`;
}

/** The organization step, carrying the intent when there is one. */
export function organizationStepPath(code: string | null): string {
  return code === null ? "/auth/organization" : `/auth/organization?${PLAN_INTENT_PARAM}=${code}`;
}

/** Billing and Plan of an org with the chosen plan marked, scrolled to that plan. */
export function billingPlanPath(orgSlug: string, code: string): string {
  return `/${orgSlug}/settings/billing-and-plan?${PLAN_INTENT_PARAM}=${code}#plan-${code}`;
}

/** Where a new organization's Owner lands: Billing and Plan with the plan marked, or Home without an intent. */
export function newOrganizationPath(orgSlug: string, plan: unknown): string {
  const code = planIntent(plan);
  return code === null ? `/${orgSlug}/home` : billingPlanPath(orgSlug, code);
}

/**
 * Where a signed-in person who already belongs to organizations lands with an intent: Billing and Plan of the org they
 * would open anyway when they are its Owner, else of the first org they own. Null when they own none, so a member who is
 * not an Owner goes to their start page and never sees the intent.
 */
export function planIntentLanding(
  orgs: readonly OwnedOrg[],
  preferredSlug: string | undefined,
  code: string | null,
): string | null {
  if (code === null) return null;
  const owns = (org: OwnedOrg) => org.roles.some((role) => role.code === "owner");
  const org = orgs.find((o) => o.slug === preferredSlug && owns(o)) ?? orgs.find(owns);
  return org === undefined ? null : billingPlanPath(org.slug, code);
}
