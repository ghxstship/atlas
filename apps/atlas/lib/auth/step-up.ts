import type { XosClient } from "@xos/data";
import { requireSecondFactor, type StepUpCheck } from "@xos/data/auth-assurance";

/**
 * Step-up for A79's server actions (Section 9 and Section 14.7: "Org deletion requires the Owner, step-up
 * authentication and typing the org name"; "the new Owner must accept and pass MFA").
 *
 * The database is the gate: every RPC that needs step-up calls private.require_step_up, which runs A77's
 * private.require_second_factor (migration 1356). This answers first with A77's same rule, requireSecondFactor
 * from @xos/data/auth-assurance (a second factor in the last 15 minutes), so the form opens the step-up dialog
 * at once. Every caller in Atlas goes through it (lib/lifecycle/actions.ts).
 */

export type StepUpResult = StepUpCheck;

/** What the action is; for example "delete the organization". The refusal from the database names it too. */
export type StepUpAction = "delete the organization" | "transfer ownership" | "accept ownership";

export function requireStepUp(db: XosClient, action: StepUpAction): Promise<StepUpResult> {
  void action;
  return requireSecondFactor(db);
}
