import type { XosClient } from "./client.ts";
import { advanceAnswerLines, type AdvanceAnswerLine } from "./gateway-operations.ts";
import type { DatabaseErrorLike } from "./result.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Gateway's `api_public` functions, callable without a session: the org brand for a host or slug
 * (A30 0850, Section 4.4.7), public person and company profiles (A30 0860, Section 4.8.2), and the
 * token flows for signing links (A28b 0769) and advance links (A10 0430, Section 4.4.6).
 *
 * The type generator does not cover `api_public` yet, so the row shapes below restate each
 * function's `returns table` from its migration; refusals arrive as rows (`refusal`, `reason`).
 * R10 (2730, 2731) adds typed answers, uploads, guests and the crew roster through an advance link.
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

export type AdvanceSectionKind =
  | "Text"
  | "File"
  | "Schedule Window"
  | "Item Request"
  | "Crew Roster"
  | "Guest List"
  | "Credential Request";

/** What an Item Request or Credential Request section offers (R9 choices, with names). */
export interface AdvanceChoice {
  readonly id: string;
  readonly assetClassId: string | null;
  readonly className: string | null;
  readonly credentialCategoryId: string | null;
  readonly categoryName: string | null;
}

/** One line of the latest answer, as the link shows it back. */
export interface AdvanceAnsweredLine {
  readonly lineNumber: number;
  readonly assetClassId: string | null;
  readonly credentialCategoryId: string | null;
  readonly rosterEntryId: string | null;
  readonly quantity: number | null;
  readonly neededFrom: string | null;
  readonly neededTo: string | null;
  readonly windowZone: string | null;
  readonly note: string | null;
}

/** A file of the latest answer and its virus scan. */
export interface AdvanceAnsweredFile {
  readonly fileId: string;
  readonly title: string;
  readonly scanStatus: string;
}

/** A person a per-person line may name: their name once they accepted, a masked email before. */
export interface AdvanceRosterPerson {
  readonly rosterEntryId: string;
  readonly displayName: string | null;
}

export interface AdvanceSection {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly prompt: string | null;
  readonly answer: string | null;
  readonly answeredAt: string | null;
  /** Review of the latest answer: Accepted, Returned, or null while it waits (or is unanswered). */
  readonly reviewOutcome: "Accepted" | "Returned" | null;
  /** Why the latest answer was returned, shown to the recipient. */
  readonly returnReason: string | null;
  /** R9 section kind and configuration (Text for a section from before R9). */
  readonly kind: AdvanceSectionKind;
  readonly windowKind: string | null;
  readonly maxLines: number | null;
  readonly perPerson: boolean;
  readonly choices: readonly AdvanceChoice[];
  readonly answerId: string | null;
  readonly answerNote: string | null;
  readonly answerLines: readonly AdvanceAnsweredLine[];
  readonly answerFiles: readonly AdvanceAnsweredFile[];
  /** False for a Crew Roster section and while the latest answer awaits review or was Accepted. */
  readonly canAnswer: boolean;
  /** Guest List: the engagement's cap (null when uncapped) and the places taken, plus-ones counted. */
  readonly guestCap: number | null;
  readonly guestsUsed: number | null;
  /** Crew Roster: entries by state, such as { Draft: 2, Submitted: 1 }. */
  readonly rosterSummary: Readonly<Record<string, number>> | null;
  /** Item and Credential Request: the roster people a line may name. */
  readonly rosterPeople: readonly AdvanceRosterPerson[];
}

/**
 * A section takes an answer when it has none or its latest answer was Returned; otherwise the
 * database refuses with advance_answer_pending (migration 2604).
 */
export function advanceSectionOpen(
  section: Pick<AdvanceSection, "answer" | "reviewOutcome"> & { readonly canAnswer?: boolean },
): boolean {
  if (section.canAnswer !== undefined) return section.canAnswer;
  return !section.answer || section.reviewOutcome === "Returned";
}

export interface AdvancePacket {
  readonly refused: false;
  readonly orgName: string;
  readonly title: string;
  readonly dueAt: string | null;
  readonly recipientEmail: string | null;
  readonly expiresAt: string | null;
  /** IANA zone of the packet's project, for the times a typed answer gives. */
  readonly timeZone: string;
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
  review_outcome: "Accepted" | "Returned" | null;
  return_reason: string | null;
  section_kind?: AdvanceSectionKind | null;
  window_kind?: string | null;
  max_lines?: number | null;
  per_person?: boolean | null;
  choices?:
    | readonly {
        id: string;
        asset_class_id: string | null;
        class_name: string | null;
        credential_category_id: string | null;
        category_name: string | null;
      }[]
    | null;
  answer_id?: string | null;
  answer_note?: string | null;
  answer_lines?:
    | readonly {
        line_number: number;
        asset_class_id?: string;
        credential_category_id?: string;
        roster_entry_id?: string;
        quantity?: number;
        needed_window_start?: string;
        needed_window_end?: string;
        window_zone?: string;
        note?: string;
      }[]
    | null;
  answer_files?: readonly { file_id: string; title: string; scan_status: string }[] | null;
  can_answer?: boolean | null;
  guest_cap?: number | null;
  guests_used?: number | null;
  roster_summary?: Record<string, number> | null;
  project_time_zone?: string | null;
  roster_people?: readonly { roster_entry_id: string; display_name: string | null }[] | null;
}

function advanceSection(r: AdvanceRow): AdvanceSection {
  const answer = r.answer_body;
  const reviewOutcome = r.review_outcome ?? null;
  return {
    id: r.section_id as string,
    position: r.section_position ?? 0,
    title: r.section_title ?? "",
    prompt: r.section_prompt,
    answer,
    answeredAt: r.answered_at,
    reviewOutcome,
    returnReason: r.return_reason ?? null,
    kind: r.section_kind ?? "Text",
    windowKind: r.window_kind ?? null,
    maxLines: r.max_lines ?? null,
    perPerson: r.per_person ?? false,
    choices: (r.choices ?? []).map((c) => ({
      id: c.id,
      assetClassId: c.asset_class_id,
      className: c.class_name,
      credentialCategoryId: c.credential_category_id,
      categoryName: c.category_name,
    })),
    answerId: r.answer_id ?? null,
    answerNote: r.answer_note ?? null,
    answerLines: (r.answer_lines ?? []).map((l) => ({
      lineNumber: l.line_number,
      assetClassId: l.asset_class_id ?? null,
      credentialCategoryId: l.credential_category_id ?? null,
      rosterEntryId: l.roster_entry_id ?? null,
      quantity: l.quantity ?? null,
      neededFrom: l.needed_window_start ?? null,
      neededTo: l.needed_window_end ?? null,
      windowZone: l.window_zone ?? null,
      note: l.note ?? null,
    })),
    answerFiles: (r.answer_files ?? []).map((f) => ({
      fileId: f.file_id,
      title: f.title,
      scanStatus: f.scan_status,
    })),
    // A row from before R10 carries no can_answer: the 2604 rule decides.
    canAnswer: r.can_answer ?? (!answer || reviewOutcome === "Returned"),
    guestCap: r.guest_cap ?? null,
    guestsUsed: r.guests_used ?? null,
    rosterSummary: r.roster_summary ?? null,
    rosterPeople: (r.roster_people ?? []).map((p) => ({
      rosterEntryId: p.roster_entry_id,
      displayName: p.display_name,
    })),
  };
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
    timeZone: first.project_time_zone ?? "UTC",
    sections: result.data
      .filter((r) => r.section_id !== null)
      .map(advanceSection)
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

/** The token, its access code and the section every typed call through an advance link names. */
interface TokenSection {
  readonly token: string;
  readonly accessCode: string;
  readonly sectionId: string;
}

function tokenArgs(input: TokenSection) {
  return { p_token: input.token, p_access_code: input.accessCode, p_section_id: input.sectionId };
}

/** The first row of a token call, or its refusal (`token_invalid` when nothing came back). */
function firstOf<T extends { refusal: string | null; reason: string | null }>(
  rows: readonly T[],
  has: (row: T) => boolean,
): T | TokenRefusal {
  const row = rows[0];
  const refused = refusalOf(row);
  if (refused) return refused;
  return row && has(row) ? row : { refused: true, reason: "token_invalid" };
}

function isRefusal(value: object): value is TokenRefusal {
  return "refused" in value && (value as TokenRefusal).refused;
}

/**
 * Answers a section of any kind through an advance link (R10 api_public.submit_advance_typed):
 * text, files from finishAdvanceUpload, windows, items or credentials, as a signed-in recipient
 * answers through app.submit_advance_answer.
 */
export async function submitAdvanceTyped(
  db: XosClient,
  input: TokenSection & {
    readonly text?: string | null;
    readonly note?: string | null;
    readonly lines?: readonly AdvanceAnswerLine[];
    readonly documentIds?: readonly string[];
  },
): Promise<Result<{ refused: false; submissionId: string; submittedAt: string } | TokenRefusal>> {
  const result = await rows<{
    submission_id: string | null;
    submitted_at: string | null;
    refusal: string | null;
    reason: string | null;
  }>(db, "submit_advance_typed", {
    ...tokenArgs(input),
    p_text: input.text?.trim() ? input.text.trim() : null,
    p_note: input.note?.trim() ? input.note.trim() : null,
    p_lines: advanceAnswerLines(input.lines ?? []),
    p_document_ids: [...(input.documentIds ?? [])],
  });
  if (!result.ok) return result;
  const row = firstOf(result.data, (r) => r.submission_id !== null && r.submitted_at !== null);
  if (isRefusal(row)) return ok(row);
  return ok({
    refused: false,
    submissionId: row.submission_id as string,
    submittedAt: row.submitted_at as string,
  });
}

/** An upload ticket for a File section (R10 api_public.begin_advance_upload), open 15 minutes. */
export async function beginAdvanceUpload(
  db: XosClient,
  input: TokenSection & {
    readonly fileName: string;
    readonly contentType: string;
    readonly byteSize: number;
  },
): Promise<
  Result<{ refused: false; ticketId: string; objectName: string; expiresAt: string } | TokenRefusal>
> {
  const result = await rows<{
    ticket_id: string | null;
    object_name: string | null;
    expires_at: string | null;
    refusal: string | null;
    reason: string | null;
  }>(db, "begin_advance_upload", {
    ...tokenArgs(input),
    p_file_name: input.fileName,
    p_content_type: input.contentType,
    p_byte_size: input.byteSize,
  });
  if (!result.ok) return result;
  const row = firstOf(result.data, (r) => r.ticket_id !== null && r.object_name !== null);
  if (isRefusal(row)) return ok(row);
  return ok({
    refused: false,
    ticketId: row.ticket_id as string,
    objectName: row.object_name as string,
    expiresAt: row.expires_at ?? "",
  });
}

/**
 * Stores the file of an upload ticket under its object name, as anon (the party-uploads token
 * policies of 2730 open exactly that object while the ticket is open).
 */
export async function storeAdvanceUpload(
  db: XosClient,
  input: { readonly objectName: string; readonly body: Blob; readonly contentType: string },
): Promise<Result<null>> {
  const stored = await db.storage
    .from("party-uploads")
    .upload(input.objectName, input.body, { contentType: input.contentType, upsert: false });
  return stored.error ? fail({ kind: "unexpected", message: stored.error.message }) : ok(null);
}

/** Registers a stored ticket's object as a document (R10 api_public.finish_advance_upload). */
export async function finishAdvanceUpload(
  db: XosClient,
  input: {
    readonly token: string;
    readonly accessCode: string;
    readonly ticketId: string;
    readonly title: string;
    readonly checksumSha256: string;
  },
): Promise<Result<{ refused: false; documentId: string } | TokenRefusal>> {
  const result = await rows<{
    document_id: string | null;
    refusal: string | null;
    reason: string | null;
  }>(db, "finish_advance_upload", {
    p_token: input.token,
    p_access_code: input.accessCode,
    p_ticket_id: input.ticketId,
    p_title: input.title,
    p_checksum_sha256: input.checksumSha256,
  });
  if (!result.ok) return result;
  const row = firstOf(result.data, (r) => r.document_id !== null);
  if (isRefusal(row)) return ok(row);
  return ok({ refused: false, documentId: row.document_id as string });
}

/** Asks for a guest on a Guest List section (R10 api_public.request_advance_guest). */
export async function requestAdvanceGuest(
  db: XosClient,
  input: TokenSection & {
    readonly guestName: string;
    readonly plusOnes: number;
    readonly note?: string | null;
    /** Where the production sends the guest's pass (B8, 2974); refused as guest_email_format when malformed. */
    readonly guestEmail?: string | null;
  },
): Promise<Result<{ refused: false; guestEntryId: string } | TokenRefusal>> {
  const result = await rows<{
    guest_entry_id: string | null;
    refusal: string | null;
    reason: string | null;
  }>(db, "request_advance_guest", {
    ...tokenArgs(input),
    p_guest_name: input.guestName,
    p_plus_ones: input.plusOnes,
    p_note: input.note?.trim() ? input.note.trim() : null,
    p_guest_email: input.guestEmail?.trim() ? input.guestEmail.trim().toLowerCase() : null,
  });
  if (!result.ok) return result;
  const row = firstOf(result.data, (r) => r.guest_entry_id !== null);
  if (isRefusal(row)) return ok(row);
  return ok({ refused: false, guestEntryId: row.guest_entry_id as string });
}

/** One person on the roster behind a Crew Roster section, as the link sees them. */
export interface AdvanceRosterEntry {
  readonly rosterEntryId: string;
  /** The person's name once they accepted, else the invited address masked (n***@example.com). */
  readonly displayName: string | null;
  readonly roleCode: string | null;
  readonly entryState: string;
  /** Pending, Accepted, Declined, Revoked or Expired; null when nobody was invited. */
  readonly invitationState: string | null;
}

/** The crew roster behind a Crew Roster section (R10 api_public.advance_roster). */
export async function listAdvanceRoster(
  db: XosClient,
  input: TokenSection,
): Promise<Result<{ refused: false; entries: AdvanceRosterEntry[] } | TokenRefusal>> {
  const result = await rows<{
    refusal: string | null;
    reason: string | null;
    roster_entry_id: string | null;
    display_name: string | null;
    role_code: string | null;
    entry_state: string | null;
    invitation_state: string | null;
  }>(db, "advance_roster", tokenArgs(input));
  if (!result.ok) return result;
  const refused = result.data[0]?.refusal ? refusalOf(result.data[0]) : null;
  if (refused) return ok(refused);
  return ok({
    refused: false,
    entries: result.data
      .filter((r) => r.roster_entry_id !== null)
      .map((r) => ({
        rosterEntryId: r.roster_entry_id as string,
        displayName: r.display_name,
        roleCode: r.role_code,
        entryState: r.entry_state ?? "Draft",
        invitationState: r.invitation_state,
      })),
  });
}

/** Invites an email address onto the roster (R10 api_public.invite_advance_roster_member). */
export async function inviteAdvanceRosterMember(
  db: XosClient,
  input: TokenSection & {
    readonly email: string;
    readonly roleCode?: string | null;
    readonly arrivalFrom?: string | null;
    readonly arrivalTo?: string | null;
    readonly arrivalZone?: string | null;
  },
): Promise<Result<{ refused: false; rosterEntryId: string } | TokenRefusal>> {
  const result = await rows<{
    roster_entry_id: string | null;
    refusal: string | null;
    reason: string | null;
  }>(db, "invite_advance_roster_member", {
    ...tokenArgs(input),
    p_email: input.email,
    p_role_code: input.roleCode ?? null,
    p_arrival_starts_at: input.arrivalFrom ?? null,
    p_arrival_ends_at: input.arrivalTo ?? null,
    p_arrival_zone: input.arrivalFrom ? (input.arrivalZone ?? null) : null,
  });
  if (!result.ok) return result;
  const row = firstOf(result.data, (r) => r.roster_entry_id !== null);
  if (isRefusal(row)) return ok(row);
  return ok({ refused: false, rosterEntryId: row.roster_entry_id as string });
}

/** Submits the roster behind a Crew Roster section (R10 api_public.submit_advance_roster). */
export async function submitAdvanceRoster(
  db: XosClient,
  input: TokenSection,
): Promise<Result<{ refused: false; submitted: number } | TokenRefusal>> {
  const result = await rows<{
    submitted: number | null;
    refusal: string | null;
    reason: string | null;
  }>(db, "submit_advance_roster", tokenArgs(input));
  if (!result.ok) return result;
  const row = firstOf(result.data, (r) => r.submitted !== null);
  if (isRefusal(row)) return ok(row);
  return ok({ refused: false, submitted: row.submitted as number });
}

/**
 * Stops a guest's emails from the org that sent them (B8, api_public.unsubscribe_guest_email, 2975). Needs a POST:
 * the RPC refuses a read-only call. Returns the org's name, or null for an unknown token, which changes nothing.
 */
export async function unsubscribeGuestEmail(
  db: XosClient,
  token: string,
): Promise<Result<string | null>> {
  const { data, error } = await publicSchema(db).rpc("unsubscribe_guest_email", { p_token: token });
  if (error) return fail(toDataError(error));
  return ok(typeof data === "string" ? data : null);
}
