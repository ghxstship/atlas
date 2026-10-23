import type { XosClient } from "./client.ts";
import {
  PARTY_CATEGORIES,
  PARTY_CHANNELS,
  type PartyCategory,
  type PartyChannel,
  type PartyPreference,
} from "./party-notifications.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Company account settings in Gateway (A86, RRR-131, finding A65-004; Section 4.5.6 external company account
 * settings): the regions a company serves and what it offers (0860; item 3), and the Owner role a member holds,
 * for handing ownership over (0710; item 8). Row level security decides every read and write: members read,
 * Account Owners and Admins edit the profile (private.can_edit_org_profile), and app.remove_account_role keeps
 * the last Account Owner.
 */

export interface ServiceRegion {
  readonly id: string;
  readonly jurisdictionId: string;
}

export interface OfferedCapability {
  readonly id: string;
  readonly categoryUrid: string;
  readonly categoryName: string | null;
}

export async function listServiceRegions(
  db: XosClient,
  accountId: string,
): Promise<Result<ServiceRegion[]>> {
  const { data, error } = await db
    .from("organization_service_regions")
    .select("id, jurisdiction_id")
    .eq("org_id", accountId)
    .is("deleted_at", null)
    .order("jurisdiction_id");
  if (error) return fail(toDataError(error));
  return ok(data.map((r) => ({ id: r.id, jurisdictionId: r.jurisdiction_id })));
}

export async function addServiceRegion(
  db: XosClient,
  accountId: string,
  jurisdictionId: string,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("organization_service_regions")
    .insert({ org_id: accountId, jurisdiction_id: jurisdictionId })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function listOfferedCapabilities(
  db: XosClient,
  accountId: string,
): Promise<Result<OfferedCapability[]>> {
  const { data, error } = await db
    .from("organization_profile_capabilities")
    .select("id, cat_urid")
    .eq("org_id", accountId)
    .is("deleted_at", null)
    .order("cat_urid");
  if (error) return fail(toDataError(error));
  if (data.length === 0) return ok([]);
  const names = await db
    .schema("xpms")
    .from("dim_category")
    .select("cat_urid, category")
    .in(
      "cat_urid",
      data.map((r) => r.cat_urid),
    );
  const name = new Map((names.data ?? []).map((n) => [n.cat_urid, n.category]));
  return ok(
    data.map((r) => ({
      id: r.id,
      categoryUrid: r.cat_urid,
      categoryName: name.get(r.cat_urid) ?? null,
    })),
  );
}

export async function addOfferedCapability(
  db: XosClient,
  accountId: string,
  categoryUrid: string,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("organization_profile_capabilities")
    .insert({ org_id: accountId, cat_urid: categoryUrid })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Removes a region or a capability from the company profile. */
export async function removeProfileEntry(
  db: XosClient,
  table: "organization_service_regions" | "organization_profile_capabilities",
  id: string,
): Promise<Result<null>> {
  const { data, error } = await db
    .from(table)
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length > 0 ? ok(null) : fail({ kind: "not-found" });
}

/** The caller's own Account Owner role in an account, to step down after handing ownership over; null if none. */
export async function myOwnerRoleId(
  db: XosClient,
  membershipId: string,
): Promise<Result<string | null>> {
  const { data, error } = await db
    .from("account_membership_roles")
    .select("id")
    .eq("account_membership_id", membershipId)
    .eq("account_role", "Account Owner")
    .is("deleted_at", null)
    .limit(1);
  if (error) return fail(toDataError(error));
  return ok(data[0]?.id ?? null);
}

// Notification defaults (1434) -------------------------------------------------------------------------------

/**
 * A company account's notification defaults for its team, per party category and outside channel. Cells without a
 * row keep the channel default (on). With `accountId` omitted, the defaults of every account the caller belongs
 * to, which is what private.person_channel_enabled falls back to.
 */
export async function getAccountNotificationDefaults(
  db: XosClient,
  accountId?: string,
): Promise<Result<PartyPreference[]>> {
  let query = db
    .from("account_notification_defaults")
    .select("category_code, channel, enabled")
    .is("deleted_at", null);
  if (accountId) query = query.eq("org_id", accountId);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok(
    data.flatMap((r) =>
      (PARTY_CATEGORIES as readonly string[]).includes(r.category_code) &&
      (PARTY_CHANNELS as readonly string[]).includes(r.channel)
        ? [
            {
              category: r.category_code as PartyCategory,
              channel: r.channel as PartyChannel,
              enabled: r.enabled,
            },
          ]
        : [],
    ),
  );
}

/** Records the company's defaults (Account Owner or Admin); the database audits each change. */
export async function saveAccountNotificationDefaults(
  db: XosClient,
  accountId: string,
  defaults: readonly PartyPreference[],
): Promise<Result<null>> {
  const { error } = await db.rpc("set_account_notification_defaults", {
    p_account_id: accountId,
    p_defaults: defaults.map((d) => ({ ...d })),
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}
