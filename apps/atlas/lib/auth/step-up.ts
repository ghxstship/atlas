import type { XosClient } from "@xos/data";

/**
 * The step-up seam of Atlas server actions (A79; Section 9 and Section 14.7: "Org deletion requires the Owner,
 * step-up authentication and typing the org name"; "the new Owner must accept and pass MFA").
 *
 * The database is the gate: every RPC that needs step-up calls private.require_step_up, which refuses
 * step_up_required unless the session passed a second factor recently. This seam lets an action answer
 * before it calls the RPC, with the same rule, so the form can offer the step-up flow at once.
 *
 * A77 (RRR-122) owns step-up: second factors, passkeys, the 15-minute window (migration 1330) and the
 * step-up dialog. Until its server check lands, this reads the assurance level of the session's tokens from
 * Supabase Auth. When it lands, replace the body of `requireStepUp` with A77's check and keep the signature;
 * every caller in Atlas goes through it (lib/lifecycle/actions.ts).
 */

export type StepUpResult =
  { readonly ok: true } | { readonly ok: false; readonly rule: "step_up_required" };

/** What the action is, for logs and the refusal; for example "delete the organization". */
export type StepUpAction = "delete the organization" | "transfer ownership" | "accept ownership";

export async function requireStepUp(db: XosClient, action: StepUpAction): Promise<StepUpResult> {
  const { data, error } = await db.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || data?.currentLevel !== "aal2") {
    return { ok: false, rule: "step_up_required" };
  }
  void action;
  return { ok: true };
}
