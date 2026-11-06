import type { Database, XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Pool invitations and standing rates (B10, G-132, ADR 0149 decision 5). An org invites an address into a Talent pool and
 * never creates a person: the invitee claims it by signing in with that address. Read through the masked lists of 6525;
 * only pool managers read invitations, because they hold the contact details of people who never joined.
 */

type Enums = Database["app"]["Enums"];
export type RateType = Enums["rate_type"];

export type InvitationStatus = "Pending" | "Expired" | "Claimed" | "Declined" | "Revoked";

export interface PoolInvitation {
  readonly id: string;
  readonly poolId: string;
  readonly email: string;
  readonly label: string | null;
  readonly workPhone: string | null;
  readonly roleCode: string | null;
  readonly jobTitle: string | null;
  readonly rateType: RateType | null;
  readonly rateMinor: number | null;
  readonly currency: string | null;
  readonly isMasked: boolean;
  readonly note: string | null;
  readonly sentAt: string | null;
  readonly expiresAt: string | null;
  readonly status: InvitationStatus;
}

export async function listPoolInvitations(
  db: XosClient,
  poolId: string,
): Promise<Result<PoolInvitation[]>> {
  const { data, error } = await db
    .from("talent_pool_invitation_list")
    .select(
      "id, talent_pool_id, email, invitee_name, work_phone, role_code, job_title, rate_type, rate_minor, currency_code, is_masked, note, created_at, expires_at, invitation_status",
    )
    .eq("talent_pool_id", poolId)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      id: r.id as string,
      poolId: r.talent_pool_id as string,
      email: r.email as string,
      label: r.invitee_name,
      workPhone: r.work_phone,
      roleCode: r.role_code,
      jobTitle: r.job_title,
      rateType: r.rate_type,
      rateMinor: r.rate_minor,
      currency: r.currency_code?.trim() ?? null,
      isMasked: r.is_masked === true,
      note: r.note,
      sentAt: r.created_at,
      expiresAt: r.expires_at,
      status: r.invitation_status as InvitationStatus,
    })),
  );
}

export interface PoolInvitationInput {
  readonly poolId: string;
  readonly email: string;
  readonly label?: string | null;
  readonly workPhone?: string | null;
  readonly roleCode?: string | null;
  readonly rate?: {
    readonly rateType: RateType;
    readonly rateMinor: number;
    readonly currency: string;
  } | null;
  readonly note?: string | null;
  readonly validForDays?: number;
}

export async function inviteToPool(
  db: XosClient,
  input: PoolInvitationInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("invite_to_talent_pool", {
    p_pool_id: input.poolId,
    p_email: input.email,
    ...(input.label ? { p_invitee_name: input.label } : {}),
    ...(input.workPhone ? { p_work_phone: input.workPhone } : {}),
    ...(input.roleCode ? { p_role_code: input.roleCode } : {}),
    ...(input.rate
      ? {
          p_rate_type: input.rate.rateType,
          p_rate_minor: input.rate.rateMinor,
          p_currency_code: input.rate.currency,
        }
      : {}),
    ...(input.note ? { p_note: input.note } : {}),
    ...(input.validForDays ? { p_valid_for: `${input.validForDays} days` } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data as string });
}

export async function reissuePoolInvitation(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await db.rpc("reissue_pool_invitation", { p_invitation_id: id });
  if (error) return fail(toDataError(error));
  return ok(null);
}

export async function revokePoolInvitation(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await db.rpc("revoke_pool_invitation", { p_invitation_id: id });
  if (error) return fail(toDataError(error));
  return ok(null);
}

export interface PoolMemberRate {
  readonly memberId: string;
  readonly rateType: RateType | null;
  readonly rateMinor: number | null;
  readonly currency: string | null;
  readonly isMasked: boolean;
}

export async function listPoolMemberRates(
  db: XosClient,
  poolId: string,
): Promise<Result<PoolMemberRate[]>> {
  const { data, error } = await db
    .from("pool_member_rate_list")
    .select("pool_member_id, rate_type, rate_minor, currency_code, is_masked")
    .eq("talent_pool_id", poolId);
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      memberId: r.pool_member_id as string,
      rateType: r.rate_type,
      rateMinor: r.rate_minor,
      currency: r.currency_code?.trim() ?? null,
      isMasked: r.is_masked === true,
    })),
  );
}

export async function setPoolMemberRate(
  db: XosClient,
  input: {
    readonly memberId: string;
    readonly rate: { rateType: RateType; rateMinor: number; currency: string } | null;
  },
): Promise<Result<null>> {
  const { error } = await db.rpc("set_pool_member_rate", {
    p_pool_member_id: input.memberId,
    ...(input.rate
      ? {
          p_rate_type: input.rate.rateType,
          p_rate_minor: input.rate.rateMinor,
          p_currency_code: input.rate.currency,
        }
      : { p_rate_type: null, p_rate_minor: null, p_currency_code: null }),
  } as never);
  if (error) return fail(toDataError(error));
  return ok(null);
}

/**
 * The number format an org's language implies, for reading a standing rate typed into the Pools form: derived from
 * Intl's own separators, comma-dot when they are anything else. A format per import stays the uploader's choice.
 */
export function numberFormatOfLocale(
  locale: string,
): "comma-dot" | "dot-comma" | "space-comma" | "apostrophe-dot" {
  const parts = new Intl.NumberFormat(locale).formatToParts(1234567.5);
  const group = parts.find((p) => p.type === "group")?.value ?? ",";
  const decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";
  if (decimal === "," && group === ".") return "dot-comma";
  if (decimal === "," && /[\s\u00a0\u202f]/.test(group)) return "space-comma";
  if (decimal === "." && (group === "'" || group === "\u2019")) return "apostrophe-dot";
  return "comma-dot";
}
