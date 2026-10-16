import type { XosClient } from "./client.ts";
import type { DatabaseErrorLike } from "./result.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Gateway's `api_public` functions, callable without a session: the org brand for a host or slug
 * (A30 0850, Section 4.4.7), public person and company profiles (A30 0860, Section 4.8.2), and the
 * token flows for signing links (A28b 0769) and advance links (A10 0430, Section 4.4.6).
 *
 * The type generator does not cover `api_public` yet, so the row shapes below restate each
 * function's `returns table` from its migration; refusals arrive as rows (`refusal`, `reason`).
 */

type PublicRpc = {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown;
    error: DatabaseErrorLike | null;
  }>;
};

function publicSchema(db: XosClient): PublicRpc {
  return (db as unknown as { schema(name: "api_public"): PublicRpc }).schema("api_public");
}

async function rows<T>(
  db: XosClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<Result<T[]>> {
  const { data, error } = await publicSchema(db).rpc(fn, args);
  if (error) return fail(toDataError(error));
  return ok(Array.isArray(data) ? (data as T[]) : []);
}

// Brand -----------------------------------------------------------------------------------------

export interface PublicBrand {
  readonly org_id: string;
  readonly org_slug: string;
  readonly name: string;
  readonly logo_light_path: string | null;
  readonly logo_dark_path: string | null;
  readonly favicon_path: string | null;
  readonly app_icon_path: string | null;
  readonly accent_hex: string | null;
  readonly neutral_tint_hex: string | null;
  readonly font_family: string | null;
  readonly radius_scale: string | null;
  readonly suppress_powered_by: boolean;
}

/** The org whose verified custom domain serves Gateway at `host`, with its brand; null when none. */
export async function brandForHost(
  db: XosClient,
  host: string,
): Promise<Result<PublicBrand | null>> {
  const result = await rows<PublicBrand & { surface: string | null }>(db, "org_brand_for_host", {
    p_host: host,
  });
  if (!result.ok) return result;
  const row = result.data.find((r) => r.surface === null || r.surface === "Gateway") ?? null;
  return ok(row);
}

/** An org's brand by slug, for org-scoped pages on the platform domain. */
export async function brandForSlug(
  db: XosClient,
  slug: string,
): Promise<Result<PublicBrand | null>> {
  const result = await rows<PublicBrand>(db, "org_brand_for_slug", { p_org_slug: slug });
  return result.ok ? ok(result.data[0] ?? null) : result;
}

// Public profiles -----------------------------------------------------------------------------------

export interface PublicPersonProfile {
  readonly handle: string;
  readonly redirected: boolean;
  readonly full_name: string | null;
  readonly preferred_name: string | null;
  readonly pronouns: string | null;
  readonly headline: string | null;
  readonly bio: string | null;
  readonly city: string | null;
  readonly country_code: string | null;
  readonly photo_path: string | null;
  readonly rate_minor: number | null;
  readonly rate_currency: string | null;
  readonly rate_unit: string | null;
  readonly visibility: string;
  readonly indexable: boolean;
  readonly viewer_is_owner: boolean;
}

export interface PublicPersonProfileFull {
  readonly profile: PublicPersonProfile;
  readonly skills: readonly { cat_urid: string; category: string }[];
  readonly languages: readonly { language_tag: string; proficiency: string | null }[];
  readonly links: readonly { label: string; url: string }[];
  readonly portfolio: readonly {
    portfolio_kind: string;
    title: string;
    description: string | null;
    url: string | null;
    media_path: string | null;
    is_epk: boolean;
  }[];
  readonly references: readonly {
    referee_name: string;
    relationship: string | null;
    organization_name: string | null;
    statement: string | null;
  }[];
  readonly certifications: readonly {
    name: string;
    issuing_body: string | null;
    issued_on: string | null;
    expires_on: string | null;
    verified: boolean;
    verified_by: string | null;
  }[];
  readonly organizations: readonly { handle: string; name: string }[];
}

/** A person's profile as the viewer may see it, with every section; null when hidden or unknown. */
export async function getPublicPersonProfile(
  db: XosClient,
  handle: string,
): Promise<Result<PublicPersonProfileFull | null>> {
  const args = { p_handle: handle };
  const [profile, skills, languages, links, portfolio, references, certifications, organizations] =
    await Promise.all([
      rows<PublicPersonProfile>(db, "person_profile", args),
      rows<PublicPersonProfileFull["skills"][number]>(db, "person_profile_skills", args),
      rows<PublicPersonProfileFull["languages"][number]>(db, "person_profile_languages", args),
      rows<PublicPersonProfileFull["links"][number]>(db, "person_profile_links", args),
      rows<PublicPersonProfileFull["portfolio"][number]>(db, "person_profile_portfolio", args),
      rows<PublicPersonProfileFull["references"][number]>(db, "person_profile_references", args),
      rows<PublicPersonProfileFull["certifications"][number]>(
        db,
        "person_profile_certifications",
        args,
      ),
      rows<PublicPersonProfileFull["organizations"][number]>(
        db,
        "person_profile_organizations",
        args,
      ),
    ]);
  for (const r of [
    profile,
    skills,
    languages,
    links,
    portfolio,
    references,
    certifications,
    organizations,
  ]) {
    if (!r.ok) return fail(r.error);
  }
  const head = profile.ok ? profile.data[0] : undefined;
  if (!head) return ok(null);
  const data = <T>(r: Result<T[]>): T[] => (r.ok ? r.data : []);
  return ok({
    profile: head,
    skills: data(skills),
    languages: data(languages),
    links: data(links),
    portfolio: data(portfolio),
    references: data(references),
    certifications: data(certifications),
    organizations: data(organizations),
  });
}

export interface PublicOrganizationProfile {
  /** The organization's id (0934), so its open opportunities are matched by org, never by name. */
  readonly org_id: string;
  readonly handle: string;
  readonly redirected: boolean;
  readonly name: string;
  readonly about: string | null;
  readonly logo_path: string | null;
  readonly cover_path: string | null;
  readonly website_url: string | null;
  readonly contact_email: string | null;
  readonly verified: boolean;
  readonly visibility: string;
  readonly indexable: boolean;
}

export interface PublicOrganizationDetail {
  readonly detail_kind: string;
  readonly code: string;
  readonly label: string;
  readonly sort_order: number;
}

/** A company profile with its capabilities, regions, verified domains and team; null when hidden. */
export async function getPublicOrganizationProfile(
  db: XosClient,
  handle: string,
): Promise<
  Result<{ profile: PublicOrganizationProfile; details: PublicOrganizationDetail[] } | null>
> {
  const [profile, details] = await Promise.all([
    rows<PublicOrganizationProfile>(db, "organization_profile", { p_handle: handle }),
    rows<PublicOrganizationDetail>(db, "organization_profile_details", { p_handle: handle }),
  ]);
  if (!profile.ok) return fail(profile.error);
  if (!details.ok) return fail(details.error);
  const head = profile.data[0];
  return ok(head ? { profile: head, details: details.data } : null);
}

// Token flows -----------------------------------------------------------------------------------------

/** A token flow refusal, as the token functions return it (`refusal = 'REFUSE'`, a rule). */
export interface TokenRefusal {
  readonly refused: true;
  readonly reason: string;
}

export interface TokenDocument {
  readonly refused: false;
  readonly orgName: string;
  readonly projectName: string | null;
  readonly kind: string;
  readonly title: string;
  readonly state: string;
  readonly expiresOn: string | null;
  readonly storageUri: string | null;
  readonly recipientEmail: string | null;
  readonly linkExpiresAt: string | null;
  readonly signedAt: string | null;
  readonly signerName: string | null;
}

interface TokenDocumentRow {
  refusal: string | null;
  reason: string | null;
  org_name: string | null;
  project_name: string | null;
  document_kind: string | null;
  title: string | null;
  document_state: string | null;
  expires_on: string | null;
  storage_uri: string | null;
  recipient_email: string | null;
  link_expires_at: string | null;
  signed_at: string | null;
  signer_name: string | null;
}

function refusalOf(
  row: { refusal: string | null; reason: string | null } | undefined,
): TokenRefusal | null {
  if (!row) return { refused: true, reason: "token_invalid" };
  return row.refusal ? { refused: true, reason: row.reason ?? "token_invalid" } : null;
}

/** The document a signing link opens, after the access code (api_public.token_document). */
export async function previewTokenDocument(
  db: XosClient,
  input: { readonly token: string; readonly accessCode: string },
): Promise<Result<TokenDocument | TokenRefusal>> {
  const result = await rows<TokenDocumentRow>(db, "token_document", {
    p_token: input.token,
    p_access_code: input.accessCode,
  });
  if (!result.ok) return result;
  const row = result.data[0];
  const refused = refusalOf(row);
  if (refused || !row) return ok(refused ?? { refused: true, reason: "token_invalid" });
  return ok({
    refused: false,
    orgName: row.org_name ?? "",
    projectName: row.project_name,
    kind: row.document_kind ?? "",
    title: row.title ?? "",
    state: row.document_state ?? "",
    expiresOn: row.expires_on,
    storageUri: row.storage_uri,
    recipientEmail: row.recipient_email,
    linkExpiresAt: row.link_expires_at,
    signedAt: row.signed_at,
    signerName: row.signer_name,
  });
}

/** Signs the document behind a signing link with the typed name (api_public.token_sign_document). */
export async function signTokenDocument(
  db: XosClient,
  input: { readonly token: string; readonly accessCode: string; readonly signerName: string },
): Promise<Result<{ refused: false; signedAt: string } | TokenRefusal>> {
  const result = await rows<{
    signed_at: string | null;
    refusal: string | null;
    reason: string | null;
  }>(db, "token_sign_document", {
    p_token: input.token,
    p_access_code: input.accessCode,
    p_signer_name: input.signerName,
  });
  if (!result.ok) return result;
  const row = result.data[0];
  const refused = refusalOf(row);
  if (refused || !row?.signed_at) return ok(refused ?? { refused: true, reason: "token_invalid" });
  return ok({ refused: false, signedAt: row.signed_at });
}

export interface AdvanceSection {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly prompt: string | null;
  readonly answer: string | null;
  readonly answeredAt: string | null;
}

export interface AdvancePacket {
  readonly refused: false;
  readonly orgName: string;
  readonly title: string;
  readonly dueAt: string | null;
  readonly recipientEmail: string | null;
  readonly expiresAt: string | null;
  readonly sections: readonly AdvanceSection[];
}

interface AdvanceRow {
  refusal: string | null;
  reason: string | null;
  org_name: string | null;
  packet_title: string | null;
  due_at: string | null;
  recipient_email: string | null;
  expires_at: string | null;
  section_id: string | null;
  section_position: number | null;
  section_title: string | null;
  section_prompt: string | null;
  answer_body: string | null;
  answered_at: string | null;
}

/** The advance packet an advance link opens, after the access code (api_public.preview_advance). */
export async function previewAdvance(
  db: XosClient,
  input: { readonly token: string; readonly accessCode: string },
): Promise<Result<AdvancePacket | TokenRefusal>> {
  const result = await rows<AdvanceRow>(db, "preview_advance", {
    p_token: input.token,
    p_access_code: input.accessCode,
  });
  if (!result.ok) return result;
  const first = result.data[0];
  const refused = refusalOf(first);
  if (refused || !first) return ok(refused ?? { refused: true, reason: "token_invalid" });
  return ok({
    refused: false,
    orgName: first.org_name ?? "",
    title: first.packet_title ?? "",
    dueAt: first.due_at,
    recipientEmail: first.recipient_email,
    expiresAt: first.expires_at,
    sections: result.data
      .filter((r) => r.section_id !== null)
      .map((r) => ({
        id: r.section_id as string,
        position: r.section_position ?? 0,
        title: r.section_title ?? "",
        prompt: r.section_prompt,
        answer: r.answer_body,
        answeredAt: r.answered_at,
      }))
      .sort((a, b) => a.position - b.position),
  });
}

/** Answers one advance section through an advance link (api_public.submit_advance). */
export async function submitAdvance(
  db: XosClient,
  input: {
    readonly token: string;
    readonly accessCode: string;
    readonly sectionId: string;
    readonly body: string;
  },
): Promise<Result<{ refused: false; submittedAt: string } | TokenRefusal>> {
  const result = await rows<{
    submission_id: string | null;
    submitted_at: string | null;
    refusal: string | null;
    reason: string | null;
  }>(db, "submit_advance", {
    p_token: input.token,
    p_access_code: input.accessCode,
    p_section_id: input.sectionId,
    p_body: input.body,
  });
  if (!result.ok) return result;
  const row = result.data[0];
  const refused = refusalOf(row);
  if (refused || !row?.submitted_at)
    return ok(refused ?? { refused: true, reason: "token_invalid" });
  return ok({ refused: false, submittedAt: row.submitted_at });
}
