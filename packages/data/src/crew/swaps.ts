import type { Database, XosClient } from "../client";
import { fail, ok, toDataError, type Result } from "../result";
import {
  MEMBERSHIP_EMBED,
  toMemberRef,
  toTransitions,
  type MemberRef,
  type TransitionEntry,
} from "./shared";

/**
 * Shift swaps (app.shift_swaps): the person on a shift asks to hand it to another member; someone with
 * crew.swap.approve who is neither party approves or rejects it (invariant 18), and the requester can
 * withdraw it. Approval reassigns the shift and keeps its acceptance.
 */

export type SwapState = Database["app"]["Enums"]["swap_state"];
export type ApprovalDecision = Database["app"]["Enums"]["approval_decision"];
export const SWAP_STATES: readonly SwapState[] = ["Proposed", "Approved", "Rejected", "Canceled"];

export interface ShiftSwap {
  readonly id: string;
  readonly shiftId: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly shiftStartsAt: string;
  readonly shiftEndsAt: string;
  readonly roleCode: string | null;
  readonly requestedBy: MemberRef;
  readonly proposed: MemberRef;
  readonly state: SwapState;
  readonly createdAt: string;
}

const SWAP_SELECT = `id, shift_id, project_id, swap_state, created_at, requested_by_membership_id, proposed_membership_id, shift:shifts!shift_swaps_shift_id_fkey(starts_at, ends_at, role_code, project:projects!shifts_project_id_fkey(project_key)), requester:memberships!shift_swaps_requested_by_membership_id_fkey(${MEMBERSHIP_EMBED}), proposed:memberships!shift_swaps_proposed_membership_id_fkey(${MEMBERSHIP_EMBED})`;

interface MembershipEmbed {
  id: string;
  person_id: string;
  person: { full_name: string | null } | null;
}

interface SwapRow {
  id: string;
  shift_id: string;
  project_id: string;
  swap_state: SwapState;
  created_at: string;
  requested_by_membership_id: string;
  proposed_membership_id: string;
  shift: {
    starts_at: string;
    ends_at: string;
    role_code: string | null;
    project: { project_key: string } | null;
  } | null;
  requester: MembershipEmbed | null;
  proposed: MembershipEmbed | null;
}

function toSwap(row: SwapRow): ShiftSwap {
  return {
    id: row.id,
    shiftId: row.shift_id,
    projectId: row.project_id,
    projectKey: row.shift?.project?.project_key ?? "",
    shiftStartsAt: row.shift?.starts_at ?? "",
    shiftEndsAt: row.shift?.ends_at ?? "",
    roleCode: row.shift?.role_code ?? null,
    requestedBy: toMemberRef(row.requester, row.requested_by_membership_id),
    proposed: toMemberRef(row.proposed, row.proposed_membership_id),
    state: row.swap_state,
    createdAt: row.created_at,
  };
}

export interface SwapFilter {
  readonly orgId: string;
  readonly projectId?: string;
  readonly states?: readonly SwapState[];
}

/** Swaps the caller may read, newest first. */
export async function listSwaps(db: XosClient, filter: SwapFilter): Promise<Result<ShiftSwap[]>> {
  let query = db
    .from("shift_swaps")
    .select(SWAP_SELECT)
    .eq("org_id", filter.orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(500);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  if (filter.states && filter.states.length > 0) query = query.in("swap_state", [...filter.states]);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok((data as unknown as SwapRow[]).map(toSwap));
}

export interface ShiftSwapDetail extends ShiftSwap {
  readonly transitions: readonly TransitionEntry[];
}

export async function getSwap(db: XosClient, id: string): Promise<Result<ShiftSwapDetail>> {
  const { data, error } = await db
    .from("shift_swaps")
    .select(SWAP_SELECT)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const ledger = await db
    .from("swap_state_transitions")
    .select("id, from_state, to_state, reason, created_at, created_by")
    .eq("shift_swap_id", id);
  if (ledger.error) return fail(toDataError(ledger.error));
  return ok({ ...toSwap(data as unknown as SwapRow), transitions: toTransitions(ledger.data) });
}

/** The person on a shift asks to hand it to another member. */
export async function requestSwap(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly shiftId: string;
    readonly requestedByMembershipId: string;
    readonly proposedMembershipId: string;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("shift_swaps")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      shift_id: input.shiftId,
      requested_by_membership_id: input.requestedByMembershipId,
      proposed_membership_id: input.proposedMembershipId,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Approves or rejects a swap (app.decide_shift_swap); never by either party. */
export async function decideSwap(
  db: XosClient,
  id: string,
  decision: ApprovalDecision,
  reason: string,
): Promise<Result<{ transitionId: string }>> {
  const { data, error } = await db.rpc("decide_shift_swap", {
    p_shift_swap_id: id,
    p_decision: decision,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ transitionId: data });
}

/** The requester withdraws a swap (app.cancel_shift_swap). */
export async function cancelSwap(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<{ transitionId: string }>> {
  const { data, error } = await db.rpc("cancel_shift_swap", {
    p_shift_swap_id: id,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ transitionId: data });
}
