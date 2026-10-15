import type { Database, XosClient } from "./client";
import { fail, ok, toDataError, type Result } from "./result";

/**
 * Profiles repository (Section 4.8.2, Section 4.8.3, Section 4.8.1): the signed-in person's own
 * profile and its sections, organization profiles, verification status, ways to join and
 * offboarding. Owner reads and writes go through row level security; others read profiles through
 * the api_public projections, which apply visibility.
 */

type Enums = Database["app"]["Enums"];
export type ProfileVisibility = Enums["profile_visibility"];
export type ProfileSection = Enums["profile_section"];
export type RateUnit = Enums["rate_unit"];
export type LanguageProficiency = Enums["language_proficiency"];

export const PROFILE_SECTIONS: readonly ProfileSection[] = [
  "photo",
  "pronouns",
  "headline",
  "bio",
  "location",
  "skills",
  "certifications",
  "portfolio",
  "rates",
  "availability",
  "languages",
  "references",
  "links",
  "organizations",
];

export interface MyProfile {
  readonly id: string;
  readonly handle: string;
  readonly handleChangedAt: string | null;
  readonly preferredName: string | null;
  readonly pronouns: string | null;
  readonly headline: string | null;
  readonly bio: string | null;
  readonly city: string | null;
  readonly countryCode: string | null;
  readonly visibility: ProfileVisibility;
  readonly searchIndexing: boolean;
  readonly marketplaceDiscoverable: boolean;
  readonly rateMinor: number | null;
  readonly rateCurrency: string | null;
  readonly rateUnit: RateUnit | null;
}

const PROFILE_COLUMNS =
  "id, handle, handle_changed_at, preferred_name, pronouns, headline, bio, city, country_code, visibility, search_indexing, marketplace_discoverable, rate_minor, rate_currency, rate_unit";

/** The signed-in person's profile, created Private with a handle from their name when missing. */
export async function getMyProfile(db: XosClient): Promise<Result<MyProfile>> {
  const ensured = await db.rpc("ensure_my_profile");
  if (ensured.error) return fail(toDataError(ensured.error));
  const { data, error } = await db
    .from("person_profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", ensured.data)
    .single();
  if (error) return fail(toDataError(error));
  return ok({
    id: data.id,
    handle: data.handle,
    handleChangedAt: data.handle_changed_at,
    preferredName: data.preferred_name,
    pronouns: data.pronouns,
    headline: data.headline,
    bio: data.bio,
    city: data.city,
    countryCode: data.country_code,
    visibility: data.visibility,
    searchIndexing: data.search_indexing,
    marketplaceDiscoverable: data.marketplace_discoverable,
    rateMinor: data.rate_minor,
    rateCurrency: data.rate_currency,
    rateUnit: data.rate_unit,
  });
}

export type ProfileInput = Omit<MyProfile, "id" | "handleChangedAt">;

/** Saves the signed-in person's profile facts, visibility and handle. */
export async function updateMyProfile(
  db: XosClient,
  profileId: string,
  input: ProfileInput,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("person_profiles")
    .update({
      handle: input.handle,
      preferred_name: input.preferredName,
      pronouns: input.pronouns,
      headline: input.headline,
      bio: input.bio,
      city: input.city,
      country_code: input.countryCode,
      visibility: input.visibility,
      search_indexing: input.searchIndexing,
      marketplace_discoverable: input.marketplaceDiscoverable,
      rate_minor: input.rateMinor,
      rate_currency: input.rateCurrency,
      rate_unit: input.rateUnit,
    })
    .eq("id", profileId)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/** Section visibility the owner set; a section without an entry follows the profile. */
export async function listSectionVisibility(
  db: XosClient,
  personId: string,
): Promise<Result<Map<ProfileSection, ProfileVisibility>>> {
  const { data, error } = await db
    .from("profile_section_visibility")
    .select("section, visibility")
    .eq("person_id", personId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(new Map(data.map((row) => [row.section, row.visibility])));
}

/** Sets one section's visibility, or clears it (null) so the section follows the profile. */
export async function setSectionVisibility(
  db: XosClient,
  input: {
    readonly personId: string;
    readonly section: ProfileSection;
    readonly visibility: ProfileVisibility | null;
  },
): Promise<Result<null>> {
  const existing = await db
    .from("profile_section_visibility")
    .select("id")
    .eq("person_id", input.personId)
    .eq("section", input.section)
    .is("deleted_at", null)
    .maybeSingle();
  if (existing.error) return fail(toDataError(existing.error));
  if (input.visibility === null) {
    if (!existing.data) return ok(null);
    const { error } = await db
      .from("profile_section_visibility")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", existing.data.id);
    return error ? fail(toDataError(error)) : ok(null);
  }
  const { error } = existing.data
    ? await db
        .from("profile_section_visibility")
        .update({ visibility: input.visibility })
        .eq("id", existing.data.id)
    : await db.from("profile_section_visibility").insert({
        person_id: input.personId,
        section: input.section,
        visibility: input.visibility,
      });
  return error ? fail(toDataError(error)) : ok(null);
}

export interface Skill {
  readonly id: string;
  readonly catUrid: string;
}

/** The person's skills, in their order. */
export async function listMySkills(db: XosClient, personId: string): Promise<Result<Skill[]>> {
  const { data, error } = await db
    .from("person_skills")
    .select("id, cat_urid, sort_order")
    .eq("person_id", personId)
    .is("deleted_at", null)
    .order("sort_order");
  if (error) return fail(toDataError(error));
  return ok(data.map((row) => ({ id: row.id, catUrid: row.cat_urid })));
}

/** Adds a skill by canon category URID. */
export async function addSkill(
  db: XosClient,
  input: { readonly personId: string; readonly catUrid: string; readonly sortOrder: number },
): Promise<Result<null>> {
  const { error } = await db.from("person_skills").insert({
    person_id: input.personId,
    cat_urid: input.catUrid,
    sort_order: input.sortOrder,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

/** Removes a row the person owns from one of their profile lists (soft delete). */
export async function removeProfileItem(
  db: XosClient,
  table: "person_skills" | "person_languages" | "person_links" | "person_certifications",
  id: string,
): Promise<Result<null>> {
  const { data, error } = await db
    .from(table)
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

export interface Language {
  readonly id: string;
  readonly tag: string;
  readonly proficiency: LanguageProficiency;
}

export async function listMyLanguages(
  db: XosClient,
  personId: string,
): Promise<Result<Language[]>> {
  const { data, error } = await db
    .from("person_languages")
    .select("id, language_tag, proficiency")
    .eq("person_id", personId)
    .is("deleted_at", null)
    .order("language_tag");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({ id: row.id, tag: row.language_tag, proficiency: row.proficiency })),
  );
}

export async function addLanguage(
  db: XosClient,
  input: {
    readonly personId: string;
    readonly tag: string;
    readonly proficiency: LanguageProficiency;
  },
): Promise<Result<null>> {
  const { error } = await db.from("person_languages").insert({
    person_id: input.personId,
    language_tag: input.tag,
    proficiency: input.proficiency,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

export interface ProfileLink {
  readonly id: string;
  readonly label: string;
  readonly url: string;
}

export async function listMyLinks(db: XosClient, personId: string): Promise<Result<ProfileLink[]>> {
  const { data, error } = await db
    .from("person_links")
    .select("id, label, url, sort_order")
    .eq("person_id", personId)
    .is("deleted_at", null)
    .order("sort_order");
  if (error) return fail(toDataError(error));
  return ok(data.map((row) => ({ id: row.id, label: row.label, url: row.url })));
}

export async function addLink(
  db: XosClient,
  input: { readonly personId: string; readonly label: string; readonly url: string },
): Promise<Result<null>> {
  const { error } = await db
    .from("person_links")
    .insert({ person_id: input.personId, label: input.label, url: input.url });
  return error ? fail(toDataError(error)) : ok(null);
}

export interface ProfileCertification {
  readonly id: string;
  readonly name: string;
  readonly issuingBody: string;
  readonly issuedOn: string;
  readonly expiresOn: string | null;
  readonly verified: boolean;
  readonly carried: boolean;
}

export async function listMyCertifications(
  db: XosClient,
  personId: string,
): Promise<Result<ProfileCertification[]>> {
  const { data, error } = await db
    .from("person_certifications")
    .select(
      "id, name, issuing_body, issued_on, expires_on, verified_at, source_certification_holder_id",
    )
    .eq("person_id", personId)
    .is("deleted_at", null)
    .order("name");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: row.id,
      name: row.name,
      issuingBody: row.issuing_body,
      issuedOn: row.issued_on,
      expiresOn: row.expires_on,
      verified: row.verified_at !== null,
      carried: row.source_certification_holder_id !== null,
    })),
  );
}

/** Adds a self-entered certification; it shows unverified until an org verifies it. */
export async function addCertification(
  db: XosClient,
  input: {
    readonly personId: string;
    readonly name: string;
    readonly issuingBody: string;
    readonly issuedOn: string;
    readonly expiresOn: string | null;
  },
): Promise<Result<null>> {
  const { error } = await db.from("person_certifications").insert({
    person_id: input.personId,
    name: input.name,
    issuing_body: input.issuingBody,
    issued_on: input.issuedOn,
    expires_on: input.expiresOn,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

export interface HeldCertification {
  readonly holderId: string;
  readonly orgName: string;
  readonly name: string;
  readonly carried: boolean;
}

/** Certifications orgs recorded for the person, and whether each is already on the profile. */
export async function listCarryableCertifications(
  db: XosClient,
  personId: string,
): Promise<Result<HeldCertification[]>> {
  const [held, carried] = await Promise.all([
    db
      .from("certification_holders")
      .select("id, certification:certifications(name, organization:organizations(name))")
      .eq("person_id", personId)
      .is("deleted_at", null),
    db
      .from("person_certifications")
      .select("source_certification_holder_id")
      .eq("person_id", personId)
      .is("deleted_at", null),
  ]);
  if (held.error) return fail(toDataError(held.error));
  if (carried.error) return fail(toDataError(carried.error));
  const on = new Set(carried.data.map((row) => row.source_certification_holder_id));
  return ok(
    held.data.map((row) => ({
      holderId: row.id,
      name: row.certification?.name ?? "",
      orgName: row.certification?.organization?.name ?? "",
      carried: on.has(row.id),
    })),
  );
}

/** Copies an org's record of the person's certification onto their profile, with its badge. */
export async function carryCertification(
  db: XosClient,
  holderId: string,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("carry_certification_to_profile", {
    p_certification_holder_id: holderId,
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

// Organization profiles ----------------------------------------------------------------------

export interface OrganizationProfile {
  readonly id: string;
  readonly handle: string;
  readonly about: string | null;
  readonly websiteUrl: string | null;
  readonly contactEmail: string | null;
  readonly visibility: ProfileVisibility;
  readonly searchIndexing: boolean;
}

/** The org's profile, created Network with its slug as handle when missing (profile editors only). */
export async function getOrganizationProfile(
  db: XosClient,
  orgId: string,
  create: boolean,
): Promise<Result<OrganizationProfile | null>> {
  if (create) {
    const ensured = await db.rpc("ensure_organization_profile", { p_org_id: orgId });
    if (ensured.error) return fail(toDataError(ensured.error));
  }
  const { data, error } = await db
    .from("organization_profiles")
    .select("id, handle, about, website_url, contact_email, visibility, search_indexing")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return ok(null);
  return ok({
    id: data.id,
    handle: data.handle,
    about: data.about,
    websiteUrl: data.website_url,
    contactEmail: data.contact_email,
    visibility: data.visibility,
    searchIndexing: data.search_indexing,
  });
}

export async function updateOrganizationProfile(
  db: XosClient,
  profileId: string,
  input: Omit<OrganizationProfile, "id">,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("organization_profiles")
    .update({
      handle: input.handle,
      about: input.about,
      website_url: input.websiteUrl,
      contact_email: input.contactEmail,
      visibility: input.visibility,
      search_indexing: input.searchIndexing,
    })
    .eq("id", profileId)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/** Whether the org's business identity is verified now (the verified badge). */
export async function isOrganizationVerified(
  db: XosClient,
  orgId: string,
): Promise<Result<boolean>> {
  const { data, error } = await db.rpc("organization_verified", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  return ok(data);
}

// Joining and offboarding ----------------------------------------------------------------------

export interface JoinRequest {
  readonly id: string;
  readonly personId: string;
  readonly personName: string | null;
  readonly message: string | null;
  readonly createdAt: string;
}

/** Pending requests to join the org, oldest first (org.members.manage by policy). */
export async function listPendingJoinRequests(
  db: XosClient,
  orgId: string,
): Promise<Result<JoinRequest[]>> {
  const { data, error } = await db
    .from("join_requests")
    .select(
      "id, person_id, message, created_at, person:people!join_requests_person_id_fkey(full_name)",
    )
    .eq("org_id", orgId)
    .eq("join_request_state", "Pending")
    .is("deleted_at", null)
    .order("created_at");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: row.id,
      personId: row.person_id,
      personName: row.person?.full_name ?? null,
      message: row.message,
      createdAt: row.created_at,
    })),
  );
}

export async function decideJoinRequest(
  db: XosClient,
  input: { readonly requestId: string; readonly approve: boolean; readonly roleId?: string },
): Promise<Result<null>> {
  const { error } = await db.rpc("decide_join_request", {
    p_join_request_id: input.requestId,
    p_approve: input.approve,
    ...(input.roleId ? { p_role_id: input.roleId } : {}),
  });
  return error ? fail(toDataError(error)) : ok(null);
}

export interface InviteLink {
  readonly id: string;
  readonly roleId: string;
  readonly expiresAt: string;
  readonly maxUses: number;
  readonly useCount: number;
}

/** Open invitation links of the org. */
export async function listInviteLinks(db: XosClient, orgId: string): Promise<Result<InviteLink[]>> {
  const { data, error } = await db
    .from("invite_links")
    .select("id, role_id, expires_at, max_uses, use_count")
    .eq("org_id", orgId)
    .is("revoked_at", null)
    .is("deleted_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("expires_at");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: row.id,
      roleId: row.role_id,
      expiresAt: row.expires_at,
      maxUses: row.max_uses,
      useCount: row.use_count,
    })),
  );
}

export async function createInviteLink(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly roleId: string;
    readonly validForHours: number;
    readonly maxUses: number;
  },
): Promise<Result<{ id: string; token: string }>> {
  const { data, error } = await db
    .rpc("create_invite_link", {
      p_org_id: input.orgId,
      p_role_id: input.roleId,
      p_valid_for: `${input.validForHours} hours`,
      p_max_uses: input.maxUses,
    })
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.invite_link_id, token: data.invite_token });
}

export async function revokeInviteLink(db: XosClient, linkId: string): Promise<Result<null>> {
  const { error } = await db.rpc("revoke_invite_link", { p_invite_link_id: linkId });
  return error ? fail(toDataError(error)) : ok(null);
}

export async function acceptInviteLink(
  db: XosClient,
  token: string,
): Promise<Result<{ membershipId: string }>> {
  const { data, error } = await db.rpc("accept_invite_link", { p_token: token });
  if (error) return fail(toDataError(error));
  return ok({ membershipId: data });
}

export interface AutoJoinOffer {
  readonly orgId: string;
  readonly orgName: string;
  readonly orgSlug: string;
}

/** Orgs the person may join through their confirmed email domain. */
export async function listAutoJoinOffers(db: XosClient): Promise<Result<AutoJoinOffer[]>> {
  const { data, error } = await db.rpc("auto_join_offers");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({ orgId: row.org_id, orgName: row.org_name, orgSlug: row.org_slug })),
  );
}

export async function joinByVerifiedDomain(
  db: XosClient,
  orgId: string,
): Promise<Result<{ membershipId: string }>> {
  const { data, error } = await db.rpc("join_by_verified_domain", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  return ok({ membershipId: data });
}

export interface Offboarding {
  readonly id: string;
  readonly personId: string;
  readonly personName: string | null;
  readonly startedAt: string;
  readonly openRecords: number;
}

/** Open offboarding checklists with how many records still wait for reassignment. */
export async function listOpenOffboardings(
  db: XosClient,
  orgId: string,
): Promise<Result<Offboarding[]>> {
  const [offboardings, open] = await Promise.all([
    db
      .from("offboardings")
      .select("id, person_id, started_at, person:people!offboardings_person_id_fkey(full_name)")
      .eq("org_id", orgId)
      .is("completed_at", null)
      .is("deleted_at", null)
      .order("started_at"),
    db.from("offboarding_open_records").select("offboarding_id").eq("org_id", orgId),
  ]);
  if (offboardings.error) return fail(toDataError(offboardings.error));
  if (open.error) return fail(toDataError(open.error));
  const counts = new Map<string, number>();
  for (const row of open.data) {
    if (row.offboarding_id)
      counts.set(row.offboarding_id, (counts.get(row.offboarding_id) ?? 0) + 1);
  }
  return ok(
    offboardings.data.map((row) => ({
      id: row.id,
      personId: row.person_id,
      personName: row.person?.full_name ?? null,
      startedAt: row.started_at,
      openRecords: counts.get(row.id) ?? 0,
    })),
  );
}

export async function reassignOffboardingRecords(
  db: XosClient,
  input: { readonly offboardingId: string; readonly toPersonId: string },
): Promise<Result<number>> {
  const { data, error } = await db.rpc("reassign_offboarding_records", {
    p_offboarding_id: input.offboardingId,
    p_to_person_id: input.toPersonId,
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

export async function completeOffboarding(
  db: XosClient,
  offboardingId: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("complete_offboarding", { p_offboarding_id: offboardingId });
  return error ? fail(toDataError(error)) : ok(null);
}
