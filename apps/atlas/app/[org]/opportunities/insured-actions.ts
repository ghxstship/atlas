"use server";

import { verifyOnboardingInsureds } from "@xos/data/insureds";
import { revalidatePath } from "next/cache";
import { actionContext } from "@/lib/collection-kit/actions";
import { uuid } from "@/lib/collection-kit/forms";
import { errorState, type OpportunityActionState } from "@/lib/opportunities/action-state";

/** Refusals of app.verify_onboarding_insureds with their own sentence in opportunities.errors. */
const INSURED_RULES: ReadonlySet<string> = new Set([
  "insureds_none_required",
  "insureds_vendor_only",
  "sod_onboarding_self_verify",
]);

/**
 * The reviewer's additional insureds step on a vendor engagement (journey 43, finding A38-001):
 * app.verify_onboarding_insureds records Passed when a current certificate names every required
 * insured and Failed naming who is missing. Needs opportunities.onboarding.write.
 */
export async function verifyInsuredsAction(
  _: OpportunityActionState,
  form: FormData,
): Promise<OpportunityActionState> {
  const ctx = await actionContext(form);
  const itemId = uuid(form, "itemId");
  if (itemId === null) return { error: "notFound" };
  const result = await verifyOnboardingInsureds(ctx.viewer.db, itemId);
  if (!result.ok) {
    if (result.error.kind === "refusal" && INSURED_RULES.has(result.error.rule)) {
      return { error: `refusal.${result.error.rule}` };
    }
    return errorState(result.error);
  }
  revalidatePath(`/${ctx.org.slug}/opportunities`, "layout");
  return result.data.outcome === "Passed"
    ? { ok: true }
    : { error: "insuredsMissing", rule: result.data.missing.join(", ") };
}
