import type { Database, XosClient } from "../client.ts";
import { fail, ok, toDataError, type Result } from "../result.ts";
import { MEMBERSHIP_EMBED, toMemberRef, type MemberRef } from "./shared.ts";

/**
 * Open shift claims (app.shift_claims, migration 1322). Under the project's claiming rule
 * (scheduling.open_shift_claiming) a claim either gives the shift at once (first-come) or waits for a
 * supervisor with crew.shift.write: approval, or seniority, where the shift goes to the most senior
 * claimant. Claimants see their own claims; shift writers see every claim on their projects.
 */

export type ShiftClaimState = Database["app"]["Enums"]["shift_claim_state"];
export type ClaimingRule = "first-come" | "approval" | "seniority";

export interface ShiftClaim {
  readonly id: string;
  readonly shiftId: string;
  readonly member: MemberRef;
  readonly state: ShiftClaimState;
  readonly reason: string | null;
  readonly createdAt: string;
}

/** The claiming rule as stored in the setting; approval (the default) for anything unknown. */
export function claimingRule(value: unknown): ClaimingRule {
  return value === "first-come" || value === "seniority" ? value : "approval";
}

/** Claims on a shift the caller may read, oldest first. */
export async function listShiftClaims(
  db: XosClient,
  shiftId: string,
  states: readonly ShiftClaimState[] = ["Requested"],
): Promise<Result<ShiftClaim[]>> {
  const { data, error } = await db
    .from("shift_claims")
    .select(
      `id, shift_id, claim_state, reason, created_at, membership_id, member:memberships!shift_claims_membership_id_fkey(${MEMBERSHIP_EMBED})`,
    )
    .eq("shift_id", shiftId)
    .in("claim_state", [...states])
    .is("deleted_at", null)
    .order("created_at");
  if (error) return fail(toDataError(error));
  return ok(
    (
      data as unknown as {
        id: string;
        shift_id: string;
        claim_state: ShiftClaimState;
        reason: string | null;
        created_at: string;
        membership_id: string;
        member: {
          id: string;
          person_id: string;
          person: { full_name: string | null } | null;
        } | null;
      }[]
    ).map((row) => ({
      id: row.id,
      shiftId: row.shift_id,
      member: toMemberRef(row.member, row.membership_id),
      state: row.claim_state,
      reason: row.reason,
      createdAt: row.created_at,
    })),
  );
}

/** Approves or rejects a waiting claim (app.decide_shift_claim); a rejection needs a reason. */
export async function decideShiftClaim(
  db: XosClient,
  id: string,
  approved: boolean,
  reason: string | null,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("decide_shift_claim", {
    p_shift_claim_id: id,
    p_approved: approved,
    ...(reason ? { p_reason: reason } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/** Gives an open shift to its most senior waiting claimant (app.award_open_shift). */
export async function awardOpenShift(
  db: XosClient,
  shiftId: string,
  reason: string,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("award_open_shift", {
    p_shift_id: shiftId,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/** The claimant withdraws a waiting claim (app.withdraw_shift_claim). */
export async function withdrawShiftClaim(
  db: XosClient,
  id: string,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("withdraw_shift_claim", { p_shift_claim_id: id });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}
