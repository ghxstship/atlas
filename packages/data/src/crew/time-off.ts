import type { Database, XosClient } from "../client.ts";
import { fail, ok, toDataError, type Result } from "../result.ts";
import {
  MEMBERSHIP_EMBED,
  toMemberRef,
  toTransitions,
  type MemberRef,
  type TransitionEntry,
} from "./shared.ts";

/**
 * Time off policies and requests (migration 0341). The requester never approves their own request
 * (sod_time_off_requester); the requester or an approver can cancel a proposed or approved request.
 * A request's day count skips holidays on the org's holiday calendar (computed field
 * app.time_off_day_count, 2270); policies are edited in Payroll and Time Off settings
 * (./payroll-settings.ts).
 */

export type TimeOffState = Database["app"]["Enums"]["time_off_state"];
export const TIME_OFF_STATES: readonly TimeOffState[] = [
  "Proposed",
  "Approved",
  "Rejected",
  "Canceled",
];

export interface TimeOffPolicy {
  readonly id: string;
  readonly name: string;
  readonly accrualHoursPerPeriod: number | null;
}

export async function listTimeOffPolicies(
  db: XosClient,
  orgId: string,
): Promise<Result<TimeOffPolicy[]>> {
  const { data, error } = await db
    .from("time_off_policies")
    .select("id, name, accrual_hours_per_period")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((p) => ({
      id: p.id,
      name: p.name,
      accrualHoursPerPeriod:
        p.accrual_hours_per_period === null ? null : Number(p.accrual_hours_per_period),
    })),
  );
}

export interface TimeOffRequest {
  readonly id: string;
  readonly policyId: string;
  readonly policyName: string;
  readonly member: MemberRef;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly hours: number;
  /** Days the request takes: every day from first to last less the org calendar's holidays. */
  readonly dayCount: number;
  readonly state: TimeOffState;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

const REQUEST_SELECT = `id, time_off_policy_id, membership_id, starts_on, ends_on, hours, time_off_day_count, time_off_state, created_by, created_at, policy:time_off_policies!time_off_requests_time_off_policy_id_fkey(name), membership:memberships!time_off_requests_membership_id_fkey(${MEMBERSHIP_EMBED})`;

interface RequestRow {
  id: string;
  time_off_policy_id: string;
  membership_id: string;
  starts_on: string;
  ends_on: string;
  hours: number;
  time_off_day_count: number | null;
  time_off_state: TimeOffState;
  created_by: string | null;
  created_at: string;
  policy: { name: string } | null;
  membership: { id: string; person_id: string; person: { full_name: string | null } | null } | null;
}

/** Days from first to last, both counted: the day count before any holiday is taken out. */
export function daysBetween(startsOn: string, endsOn: string): number {
  return (
    Math.round(
      (Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`)) / 86_400_000,
    ) + 1
  );
}

function toRequest(r: RequestRow): TimeOffRequest {
  return {
    id: r.id,
    policyId: r.time_off_policy_id,
    policyName: r.policy?.name ?? "",
    member: toMemberRef(r.membership, r.membership_id),
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    hours: Number(r.hours),
    dayCount: r.time_off_day_count ?? daysBetween(r.starts_on, r.ends_on),
    state: r.time_off_state,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export async function listTimeOffRequests(
  db: XosClient,
  filter: {
    readonly orgId: string;
    readonly membershipId?: string;
    readonly states?: readonly TimeOffState[];
  },
): Promise<Result<TimeOffRequest[]>> {
  let query = db
    .from("time_off_requests")
    .select(REQUEST_SELECT)
    .eq("org_id", filter.orgId)
    .is("deleted_at", null)
    .order("starts_on", { ascending: false })
    .limit(500);
  if (filter.membershipId) query = query.eq("membership_id", filter.membershipId);
  if (filter.states && filter.states.length > 0)
    query = query.in("time_off_state", [...filter.states]);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok((data as unknown as RequestRow[]).map(toRequest));
}

export interface TimeOffRequestDetail extends TimeOffRequest {
  readonly transitions: readonly TransitionEntry[];
}

export async function getTimeOffRequest(
  db: XosClient,
  id: string,
): Promise<Result<TimeOffRequestDetail>> {
  const { data, error } = await db
    .from("time_off_requests")
    .select(REQUEST_SELECT)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const ledger = await db
    .from("time_off_state_transitions")
    .select("id, from_state, to_state, reason, created_at, created_by")
    .eq("time_off_request_id", id);
  if (ledger.error) return fail(toDataError(ledger.error));
  return ok({
    ...toRequest(data as unknown as RequestRow),
    transitions: toTransitions(ledger.data),
  });
}

export async function requestTimeOff(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly policyId: string;
    readonly membershipId: string;
    readonly startsOn: string;
    readonly endsOn: string;
    readonly hours: number;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("time_off_requests")
    .insert({
      org_id: input.orgId,
      time_off_policy_id: input.policyId,
      membership_id: input.membershipId,
      starts_on: input.startsOn,
      ends_on: input.endsOn,
      hours: input.hours,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function decideTimeOff(
  db: XosClient,
  id: string,
  decision: Database["app"]["Enums"]["approval_decision"],
  reason: string,
): Promise<Result<{ transitionId: string }>> {
  const { data, error } = await db.rpc("decide_time_off", {
    p_time_off_request_id: id,
    p_decision: decision,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ transitionId: data });
}

export async function cancelTimeOff(
  db: XosClient,
  id: string,
  expected: TimeOffState,
  reason: string,
): Promise<Result<{ transitionId: string }>> {
  const { data, error } = await db.rpc("cancel_time_off", {
    p_time_off_request_id: id,
    p_expected: expected,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ transitionId: data });
}
