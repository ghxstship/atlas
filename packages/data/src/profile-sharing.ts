import type { Database, XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Profile sharing and organization discovery (migration 1132, finding A38-003, journeys 61 and
 * 62): a person shares chosen sections of their own profile with the org they apply to; the org
 * reads what was shared on the application; Explore lists Public organization profiles.
 */

export type ProfileSection = Database["app"]["Enums"]["profile_section"];

/** Sections a person may share with an org, in display order. */
export const SHAREABLE_SECTIONS: readonly ProfileSection[] = [
  "headline",
  "bio",
  "pronouns",
  "location",
  "skills",
  "certifications",
  "rates",
  "languages",
  "links",
];

/** Shares sections of the signed-in person's profile with one org; returns the share id. */
export async function shareProfileSections(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly profileShareId: string | null;
    readonly sections: readonly ProfileSection[];
  },
): Promise<Result<{ profileShareId: string }>> {
  const { data, error } = await db.rpc("share_profile_sections", {
    p_org_id: input.orgId,
    p_profile_share_id: input.profileShareId,
    p_sections: [...input.sections],
  } as never);
  if (error) return fail(toDataError(error));
  return ok({ profileShareId: String(data) });
}

export interface SharedField {
  readonly key: string;
  readonly value: string | null;
}

export interface SharedProfile {
  readonly sharedAt: string;
  readonly revoked: boolean;
  readonly fields: readonly SharedField[];
}

/** What the applicant shared with the org on an application, or null when nothing was shared. */
export async function getApplicationSharedProfile(
  db: XosClient,
  applicationId: string,
): Promise<Result<SharedProfile | null>> {
  const application = await db
    .from("applications")
    .select("profile_share_id")
    .eq("id", applicationId)
    .maybeSingle();
  if (application.error) return fail(toDataError(application.error));
  const shareId = application.data?.profile_share_id ?? null;
  if (shareId === null) return ok(null);
  const [share, fields] = await Promise.all([
    db.from("profile_shares").select("shared_at, revoked_at").eq("id", shareId).maybeSingle(),
    db
      .from("profile_share_fields")
      .select("field_key, field_value")
      .eq("profile_share_id", shareId)
      .is("deleted_at", null)
      .order("field_key"),
  ]);
  if (share.error) return fail(toDataError(share.error));
  if (fields.error) return fail(toDataError(fields.error));
  if (!share.data) return ok(null);
  return ok({
    sharedAt: share.data.shared_at,
    revoked: share.data.revoked_at !== null,
    fields: (fields.data ?? []).map((f) => ({ key: f.field_key, value: f.field_value })),
  });
}

/** A shared rate (profile.rates): minor units, currency and unit; null when unreadable. */
export function parseSharedRate(
  value: string | null,
): { amountMinor: number; currency: string; unit: string } | null {
  if (value === null) return null;
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    const amount = raw["amount_minor"];
    const currency = raw["currency"];
    const unit = raw["unit"];
    return typeof amount === "number" && typeof currency === "string" && typeof unit === "string"
      ? { amountMinor: amount, currency, unit }
      : null;
  } catch (error: unknown) {
    // Not JSON: the caller shows the stored text as it is.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export interface ExploreOrganization {
  readonly handle: string;
  readonly name: string;
  readonly about: string | null;
  readonly logoPath: string | null;
  readonly verified: boolean;
  readonly verifiedDomain: string | null;
  readonly openOpportunities: number;
}

/** Public organization profiles for Explore, optionally matching a query. */
export async function exploreOrganizations(
  db: XosClient,
  query: string | null,
  limit = 24,
): Promise<Result<ExploreOrganization[]>> {
  const { data, error } = await db.rpc("explore_organizations", {
    ...(query ? { p_query: query } : {}),
    p_limit: limit,
  });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      handle: r.handle,
      name: r.name,
      about: r.about,
      logoPath: r.logo_path,
      verified: r.verified === true,
      verifiedDomain: r.verified_domain,
      openOpportunities: r.open_opportunities ?? 0,
    })),
  );
}
