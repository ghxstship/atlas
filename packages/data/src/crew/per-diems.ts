import type { XosClient } from "../client.ts";
import { fail, ok, toDataError, type Result } from "../result.ts";
import {
  ENGAGEMENT_EMBED,
  MEMBERSHIP_EMBED,
  type EngagementRow,
  type MembershipRow,
} from "./shared.ts";

/**
 * Per diems (migrations 0341, 0981 and 2603): one allowance a day for a member or for the person of an
 * engagement. Atlas Crew > Per Diems adds a run of days through app.add_per_diems, which needs
 * crew.time_entry.write on the project; removing one is a soft delete under the same write policy.
 */

export interface PerDiem {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly membershipId: string | null;
  readonly engagementId: string | null;
  readonly personId: string | null;
  /** The person's name, from the membership or the engagement; null when the person row is hidden. */
  readonly personName: string | null;
  readonly day: string;
  readonly amountMinor: number;
  readonly currencyCode: string;
}

const PER_DIEM_SELECT = `id, project_id, membership_id, engagement_id, day, amount_minor, currency_code, project:projects!per_diems_project_id_fkey(project_key), membership:memberships!per_diems_membership_id_fkey(${MEMBERSHIP_EMBED}), engagement:engagements!per_diems_engagement_id_fkey(${ENGAGEMENT_EMBED})`;

interface PerDiemRow {
  id: string;
  project_id: string;
  membership_id: string | null;
  engagement_id: string | null;
  day: string;
  amount_minor: number;
  currency_code: string;
  project: { project_key: string } | null;
  membership: MembershipRow | null;
  engagement: EngagementRow | null;
}

function toPerDiem(r: PerDiemRow): PerDiem {
  return {
    id: r.id,
    projectId: r.project_id,
    projectKey: r.project?.project_key ?? "",
    membershipId: r.membership_id,
    engagementId: r.engagement_id,
    personId: r.membership?.person_id ?? r.engagement?.person_id ?? null,
    personName: r.membership?.person?.full_name ?? r.engagement?.person?.full_name ?? null,
    day: r.day,
    amountMinor: Number(r.amount_minor),
    currencyCode: r.currency_code,
  };
}

export async function listPerDiems(
  db: XosClient,
  filter: { readonly orgId: string; readonly projectId?: string | null },
): Promise<Result<PerDiem[]>> {
  let query = db
    .from("per_diems")
    .select(PER_DIEM_SELECT)
    .eq("org_id", filter.orgId)
    .is("deleted_at", null)
    .order("day", { ascending: false })
    .limit(500);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok((data as unknown as PerDiemRow[]).map(toPerDiem));
}

export interface PerDiemInput {
  readonly projectId: string;
  /** Exactly one of membershipId and engagementId. */
  readonly membershipId: string | null;
  readonly engagementId: string | null;
  /** First and last day, inclusive (YYYY-MM-DD); at most 62 days. */
  readonly from: string;
  readonly to: string;
  readonly amountMinor: number;
  readonly currencyCode: string;
}

/**
 * Adds one per diem a day from `from` to `to`. Refusals come back typed: per_diem_one_worker,
 * per_diem_range, per_diem_member_org, per_diem_day_taken, and the worker triggers'
 * engagement_worker_person and engagement_not_working.
 */
export async function addPerDiems(
  db: XosClient,
  input: PerDiemInput,
): Promise<Result<{ count: number }>> {
  const { data, error } = await db.rpc("add_per_diems", {
    p_project_id: input.projectId,
    p_membership_id: input.membershipId as string,
    p_engagement_id: input.engagementId as string,
    p_from: input.from,
    p_to: input.to,
    p_amount_minor: input.amountMinor,
    p_currency_code: input.currencyCode,
  });
  if (error) return fail(toDataError(error));
  return ok({ count: Number(data ?? 0) });
}

export async function removePerDiem(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("per_diems")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}
