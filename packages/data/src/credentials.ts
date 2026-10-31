import type { XosClient } from "./client.ts";
import { fillPersonNames } from "./person-names.ts";
import { fail, ok, toDataError, type DatabaseErrorLike, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Credentials repository (Section 4.2 Credentials, Section 7.4, invariant 21): credential
 * categories, issued credentials, the access grid and the scan log. Every read goes through row
 * level security and every write through the guards of migration 0352: the database sets the
 * issuer from the session and refuses self-issue, numbers credentials from the org sequence,
 * stamps revocation and decides each scan from the access grid at the database time. Compass (A17)
 * calls the same functions; their writes take an optional client id so an offline replay is a
 * no-op that returns the row already stored.
 */

// Shared ---------------------------------------------------------------------------------------

/** A project as the operations modules show it: key, name and the venue whose zones it uses. */
export interface OperationsProject {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly venueId: string | null;
  /** IANA time zone the project's local times are typed in. */
  readonly timeZone: string;
}

interface ProjectRow {
  id: string;
  project_key: string;
  name: string;
  venue_id: string | null;
  time_zone: string;
}

const PROJECT_COLUMNS = "id, project_key, name, venue_id, time_zone";

function toProject(row: ProjectRow): OperationsProject {
  return {
    id: row.id,
    key: row.project_key,
    name: row.name,
    venueId: row.venue_id,
    timeZone: row.time_zone,
  };
}

/** Projects of an org the viewer may read, in key order, for project filters and pickers. */
export async function operationsProjects(
  db: XosClient,
  orgId: string,
): Promise<Result<OperationsProject[]>> {
  const { data, error } = await db
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .is("archived_at", null)
    .order("project_key");
  if (error) return fail(toDataError(error));
  return ok((data as ProjectRow[]).map(toProject));
}

/** One project by its key, or not-found when it does not exist or the viewer may not read it. */
export async function operationsProjectByKey(
  db: XosClient,
  orgId: string,
  projectKey: string,
): Promise<Result<OperationsProject>> {
  const { data, error } = await db
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("org_id", orgId)
    .eq("project_key", projectKey)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(toProject(data as ProjectRow));
}

/** A zone of a venue, used by the access grid, scans, incidents and the radio plan. */
export interface Zone {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly venueId: string;
  readonly venueName: string;
}

/**
 * Zones a project can use. A project works across several venues (its standing venues and shows),
 * so every zone of the org the viewer may read is offered: the project's primary venue first, then
 * the others by venue name, each in code order (Section 3.6).
 */
export async function listProjectZones(
  db: XosClient,
  orgId: string,
  venueId: string | null,
): Promise<Result<Zone[]>> {
  const { data, error } = await db
    .from("zones")
    .select("id, code, name, venue_id, venue:venues(name)")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("code");
  if (error) return fail(toDataError(error));
  const zones = (
    data as unknown as {
      id: string;
      code: string;
      name: string;
      venue_id: string;
      venue: { name: string } | null;
    }[]
  ).map((z) => ({
    id: z.id,
    code: z.code,
    name: z.name,
    venueId: z.venue_id,
    venueName: z.venue?.name ?? "",
  }));
  const rank = (z: Zone) => (z.venueId === venueId ? 0 : 1);
  return ok(
    zones.sort(
      (x, y) =>
        rank(x) - rank(y) || x.venueName.localeCompare(y.venueName) || x.code.localeCompare(y.code),
    ),
  );
}

/** True when a unique key rejected a client-chosen primary key that is already stored. */
export function isReplay(error: DatabaseErrorLike, id: string | undefined): boolean {
  return id !== undefined && error.code === "23505" && /_pkey/.test(error.message);
}

// Categories -----------------------------------------------------------------------------------

export interface CredentialCategory {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly code: string;
  readonly name: string;
  /** Access for a badge, Parking for a parking pass (R7, 2691). */
  readonly kind: CredentialCategoryKind;
  /** Credentials of this category that are not revoked. */
  readonly activeCount: number;
}

export type CredentialCategoryKind = "Access" | "Parking";

interface CategoryRow {
  id: string;
  project_id: string;
  code: string;
  name: string;
  category_kind: CredentialCategoryKind | null;
  project: { project_key: string } | null;
  credentials: { revoked_at: string | null; deleted_at: string | null }[] | null;
}

const CATEGORY_COLUMNS =
  "id, project_id, code, name, category_kind, project:projects!credential_categories_project_id_fkey(project_key), credentials(revoked_at, deleted_at)";

function toCategory(row: CategoryRow): CredentialCategory {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project?.project_key ?? "",
    code: row.code,
    name: row.name,
    kind: row.category_kind === "Parking" ? "Parking" : "Access",
    activeCount: (row.credentials ?? []).filter((c) => c.revoked_at === null && !c.deleted_at)
      .length,
  };
}

/** Categories in project key, then code order (Section 3.6). */
export async function listCredentialCategories(
  db: XosClient,
  filter: { readonly orgId: string; readonly projectId?: string },
): Promise<Result<CredentialCategory[]>> {
  let query = db
    .from("credential_categories")
    .select(CATEGORY_COLUMNS)
    .eq("org_id", filter.orgId)
    .is("deleted_at", null);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  const { data, error } = await query.order("code");
  if (error) return fail(toDataError(error));
  const rows = (data as unknown as CategoryRow[]).map(toCategory);
  return ok(
    rows.sort((a, b) => a.projectKey.localeCompare(b.projectKey) || a.code.localeCompare(b.code)),
  );
}

export async function getCredentialCategory(
  db: XosClient,
  id: string,
): Promise<Result<CredentialCategory>> {
  const { data, error } = await db
    .from("credential_categories")
    .select(CATEGORY_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(toCategory(data as unknown as CategoryRow));
}

export interface CategoryInput {
  readonly code: string;
  readonly name: string;
  /** Left out, a new category is Access and an edit keeps the kind. */
  readonly kind?: CredentialCategoryKind | undefined;
}

/** Category codes are capitals, digits and hyphens, at most 16 characters (migration 0352). */
export const CATEGORY_CODE = /^[A-Z0-9][A-Z0-9-]{0,15}$/;

export async function createCredentialCategory(
  db: XosClient,
  input: CategoryInput & { readonly orgId: string; readonly projectId: string },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("credential_categories")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      code: input.code.trim().toUpperCase(),
      name: input.name.trim(),
      ...(input.kind ? { category_kind: input.kind } : {}),
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function updateCredentialCategory(
  db: XosClient,
  id: string,
  input: CategoryInput,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("credential_categories")
    .update({
      code: input.code.trim().toUpperCase(),
      name: input.name.trim(),
      ...(input.kind ? { category_kind: input.kind } : {}),
    })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail({ kind: "not-found" }) : ok(null);
}

/** Archives a category (soft delete); its issued credentials and scan history stay. */
export async function archiveCredentialCategory(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("credential_categories")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail({ kind: "not-found" }) : ok(null);
}

// Issued credentials ---------------------------------------------------------------------------

/** Where a credential stands at a moment: derived from its window and revocation, never stored. */
export type CredentialStatus = "active" | "scheduled" | "expired" | "revoked";

export const CREDENTIAL_STATUSES: readonly CredentialStatus[] = [
  "scheduled",
  "active",
  "expired",
  "revoked",
];

export function credentialStatus(
  c: {
    readonly validFrom: string;
    readonly validTo: string | null;
    readonly revokedAt: string | null;
  },
  now: Date = new Date(),
): CredentialStatus {
  if (c.revokedAt !== null) return "revoked";
  if (new Date(c.validFrom) > now) return "scheduled";
  if (c.validTo !== null && new Date(c.validTo) <= now) return "expired";
  return "active";
}

export interface IssuedCredential {
  readonly id: string;
  readonly number: string;
  readonly holderPersonId: string;
  readonly holderName: string | null;
  readonly categoryId: string;
  readonly categoryCode: string;
  readonly categoryName: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly issuedByName: string | null;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly revokedAt: string | null;
  readonly revokedByName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface CredentialRow {
  id: string;
  credential_number: string;
  holder_person_id: string;
  credential_category_id: string;
  valid_from: string;
  valid_to: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
  holder: { full_name: string | null } | null;
  issuer: { full_name: string | null } | null;
  revoker: { full_name: string | null } | null;
  category: {
    code: string;
    name: string;
    project_id: string;
    project: { project_key: string } | null;
  } | null;
}

const CREDENTIAL_COLUMNS = [
  "id, credential_number, holder_person_id, credential_category_id, valid_from, valid_to, revoked_at, created_at, updated_at",
  "holder:people!credentials_holder_person_id_fkey(full_name)",
  "issuer:people!credentials_issued_by_fkey(full_name)",
  "revoker:people!credentials_revoked_by_fkey(full_name)",
  "category:credential_categories!inner(code, name, project_id, project:projects!credential_categories_project_id_fkey(project_key))",
].join(", ");

function toCredential(row: CredentialRow): IssuedCredential {
  return {
    id: row.id,
    number: row.credential_number,
    holderPersonId: row.holder_person_id,
    holderName: row.holder?.full_name ?? null,
    categoryId: row.credential_category_id,
    categoryCode: row.category?.code ?? "",
    categoryName: row.category?.name ?? "",
    projectId: row.category?.project_id ?? "",
    projectKey: row.category?.project?.project_key ?? "",
    issuedByName: row.issuer?.full_name ?? null,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    revokedAt: row.revoked_at,
    revokedByName: row.revoker?.full_name ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CredentialFilter {
  readonly orgId: string;
  readonly projectId?: string;
  readonly categoryId?: string;
  readonly holderPersonId?: string;
}

/** Issued credentials in number order, newest number last. */
export async function listIssuedCredentials(
  db: XosClient,
  filter: CredentialFilter,
): Promise<Result<IssuedCredential[]>> {
  let query = db
    .from("credentials")
    .select(CREDENTIAL_COLUMNS)
    .eq("org_id", filter.orgId)
    .is("deleted_at", null);
  if (filter.projectId) query = query.eq("category.project_id", filter.projectId);
  if (filter.categoryId) query = query.eq("credential_category_id", filter.categoryId);
  if (filter.holderPersonId) query = query.eq("holder_person_id", filter.holderPersonId);
  const { data, error } = await query.order("credential_number");
  if (error) return fail(toDataError(error));
  return ok(await namedHolders(db, (data as unknown as CredentialRow[]).map(toCredential)));
}

/** Holder names through the one name resolution (A59-011): engaged crew are named, not "Unnamed". */
function namedHolders(
  db: XosClient,
  list: readonly IssuedCredential[],
): Promise<IssuedCredential[]> {
  return fillPersonNames(
    db,
    list,
    (c) => c.holderPersonId,
    (c) => c.holderName,
    (c, holderName) => ({ ...c, holderName }),
  );
}

/** The credentials of a project, for Compass to decide scans offline (A17). */
export function listProjectCredentials(
  db: XosClient,
  orgId: string,
  projectId: string,
): Promise<Result<IssuedCredential[]>> {
  return listIssuedCredentials(db, { orgId, projectId });
}

/** The signed-in person's own credentials across their orgs, for the Compass badge (A17). */
export async function listMyCredentials(
  db: XosClient,
  personId: string,
): Promise<Result<IssuedCredential[]>> {
  const { data, error } = await db
    .from("credentials")
    .select(CREDENTIAL_COLUMNS)
    .eq("holder_person_id", personId)
    .is("deleted_at", null)
    .is("revoked_at", null)
    .order("valid_from");
  if (error) return fail(toDataError(error));
  return ok((data as unknown as CredentialRow[]).map(toCredential));
}

export async function getIssuedCredential(
  db: XosClient,
  id: string,
): Promise<Result<IssuedCredential>> {
  const { data, error } = await db
    .from("credentials")
    .select(CREDENTIAL_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const [credential] = await namedHolders(db, [toCredential(data as unknown as CredentialRow)]);
  return ok(credential as IssuedCredential);
}

/** Credentials by id, as the caller reads them, for a batch of badges (P5). Order follows credential number. */
export async function getIssuedCredentials(
  db: XosClient,
  ids: readonly string[],
): Promise<Result<IssuedCredential[]>> {
  if (ids.length === 0) return ok([]);
  const { data, error } = await db
    .from("credentials")
    .select(CREDENTIAL_COLUMNS)
    .in("id", [...ids])
    .is("deleted_at", null)
    .order("credential_number");
  if (error) return fail(toDataError(error));
  return ok(await namedHolders(db, (data as unknown as CredentialRow[]).map(toCredential)));
}

/** A credential by its printed number, for scanning a badge whose id is not on the device. */
export async function lookupCredentialByNumber(
  db: XosClient,
  orgId: string,
  credentialNumber: string,
): Promise<Result<IssuedCredential>> {
  const { data, error } = await db
    .from("credentials")
    .select(CREDENTIAL_COLUMNS)
    .eq("org_id", orgId)
    .eq("credential_number", credentialNumber.trim().toUpperCase())
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const [credential] = await namedHolders(db, [toCredential(data as unknown as CredentialRow)]);
  return ok(credential as IssuedCredential);
}

export interface IssueCredentialInput {
  readonly orgId: string;
  /** Project of the category; the database copies it from the category whatever is sent. */
  readonly projectId: string;
  readonly categoryId: string;
  /** Engagement the badge is issued under, such as an artist's party badge. */
  readonly engagementId?: string | null;
  readonly holderPersonId: string;
  readonly validFrom?: string;
  readonly validTo?: string | null;
}

/**
 * Issues a credential. The database sets the issuer from the session, refuses self-issue
 * (`credential_self_issue`, invariant 21) and assigns the number.
 */
export async function issueCredential(
  db: XosClient,
  input: IssueCredentialInput,
): Promise<Result<{ id: string; number: string }>> {
  const { data, error } = await db
    .from("credentials")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      credential_category_id: input.categoryId,
      holder_person_id: input.holderPersonId,
      engagement_id: input.engagementId ?? null,
      ...(input.validFrom ? { valid_from: input.validFrom } : {}),
      valid_to: input.validTo ?? null,
    })
    .select("id, credential_number")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id, number: data.credential_number });
}

/** Changes when a credential works. Holder, issuer, number and category never change. */
export async function updateCredentialWindow(
  db: XosClient,
  id: string,
  window: { readonly validFrom: string; readonly validTo: string | null },
): Promise<Result<null>> {
  const { data, error } = await db
    .from("credentials")
    .update({ valid_from: window.validFrom, valid_to: window.validTo })
    .eq("id", id)
    .is("deleted_at", null)
    .is("revoked_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail({ kind: "not-found" }) : ok(null);
}

/**
 * Revokes a credential. The database stamps the time and the revoker, needs
 * credentials.credential.revoke on the project and refuses a second revocation.
 */
export async function revokeCredential(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("credentials")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail({ kind: "not-found" }) : ok(null);
}

// Access grid ----------------------------------------------------------------------------------

/** A canon Access Level (Bible enumerations), read from xpms.std_enumeration. */
export interface AccessLevel {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly sortOrder: number;
}

export async function listAccessLevels(db: XosClient): Promise<Result<AccessLevel[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("std_enumeration")
    .select("record_id, enum_code, enum_label, sort_order")
    .eq("enum_domain", "Access Level")
    .order("sort_order");
  if (error) return fail(toDataError(error));
  return ok(
    (
      data as {
        record_id: string;
        enum_code: string | null;
        enum_label: string | null;
        sort_order: number | null;
      }[]
    ).map((r) => ({
      id: r.record_id,
      code: r.enum_code ?? r.record_id,
      label: r.enum_label ?? r.record_id,
      sortOrder: Number(r.sort_order ?? 0),
    })),
  );
}

export interface AccessGridEntry {
  readonly id: string;
  readonly categoryId: string;
  readonly zoneId: string;
  readonly zoneCode: string;
  readonly zoneName: string;
  readonly accessLevelId: string;
  readonly windowStartsAt: string;
  readonly windowEndsAt: string;
}

interface GridRow {
  id: string;
  credential_category_id: string;
  zone_id: string;
  access_level_enum_id: string;
  window_starts_at: string;
  window_ends_at: string;
  zone: { code: string; name: string } | null;
  category: { project_id: string } | null;
}

/** The access grid of a project: one row per category, zone and window. */
export async function listAccessGrid(
  db: XosClient,
  orgId: string,
  projectId: string,
): Promise<Result<AccessGridEntry[]>> {
  const { data, error } = await db
    .from("access_grid")
    .select(
      "id, credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at, zone:zones(code, name), category:credential_categories!inner(project_id)",
    )
    .eq("org_id", orgId)
    .eq("category.project_id", projectId)
    .is("deleted_at", null)
    .order("window_starts_at");
  if (error) return fail(toDataError(error));
  return ok(
    (data as unknown as GridRow[]).map((r) => ({
      id: r.id,
      categoryId: r.credential_category_id,
      zoneId: r.zone_id,
      zoneCode: r.zone?.code ?? "",
      zoneName: r.zone?.name ?? "",
      accessLevelId: r.access_level_enum_id,
      windowStartsAt: r.window_starts_at,
      windowEndsAt: r.window_ends_at,
    })),
  );
}

export interface AccessGridInput {
  readonly orgId: string;
  /** Project of the category; the database copies it from the category whatever is sent. */
  readonly projectId: string;
  readonly categoryId: string;
  readonly zoneId: string;
  readonly accessLevelId: string;
  readonly windowStartsAt: string;
  readonly windowEndsAt: string;
}

/** Grants a category entry to a zone at a canon access level during a window. */
export async function grantZoneAccess(
  db: XosClient,
  input: AccessGridInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("access_grid")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      credential_category_id: input.categoryId,
      zone_id: input.zoneId,
      access_level_enum_id: input.accessLevelId,
      window_starts_at: input.windowStartsAt,
      window_ends_at: input.windowEndsAt,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function updateZoneAccess(
  db: XosClient,
  id: string,
  input: Pick<AccessGridInput, "accessLevelId" | "windowStartsAt" | "windowEndsAt">,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("access_grid")
    .update({
      access_level_enum_id: input.accessLevelId,
      window_starts_at: input.windowStartsAt,
      window_ends_at: input.windowEndsAt,
    })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail({ kind: "not-found" }) : ok(null);
}

/** Withdraws a grant (soft delete); scans already decided keep their result. */
export async function withdrawZoneAccess(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("access_grid")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail({ kind: "not-found" }) : ok(null);
}

// Scans ----------------------------------------------------------------------------------------

export type ScanResult = "Granted" | "Denied";

/** In or Out (B8, migration 2970). Exit is never refused. */
export type ScanDirection = "In" | "Out";

export const SCAN_DIRECTIONS: readonly ScanDirection[] = ["In", "Out"];

/** Why the database denied an In scan (2970), in Compass's decideGate order. Denials before 2970 carry none. */
export type ScanRefusalReason =
  "Revoked" | "Not Yet Valid" | "Expired" | "No Zone Access" | "Outside Window";

/** The catalog key of a refusal reason: credentials.scans.reasons.{key}. */
export const refusalReasonKey = (reason: ScanRefusalReason) => reason.replace(/ /g, "");

export interface AccessScan {
  readonly id: string;
  readonly credentialId: string;
  readonly credentialNumber: string;
  readonly holderName: string | null;
  readonly categoryCode: string;
  readonly projectKey: string;
  readonly zoneId: string;
  readonly zoneCode: string;
  readonly zoneName: string;
  readonly scannedAt: string;
  readonly result: ScanResult;
  readonly direction: ScanDirection;
  readonly refusalReason: ScanRefusalReason | null;
  /** The Denied In scan this Granted In row overrides; set only by app.override_access_scan. */
  readonly overrideOfScanId: string | null;
  readonly overrideReason: string | null;
  /** Who recorded the scan; for an override, who let the person in. */
  readonly createdBy: string | null;
  readonly createdByName: string | null;
}

interface ScanRow {
  id: string;
  credential_id: string;
  zone_id: string;
  scanned_at: string;
  result: ScanResult;
  direction: ScanDirection;
  refusal_reason: ScanRefusalReason | null;
  override_of_scan_id: string | null;
  override_reason: string | null;
  created_by: string | null;
  /** Filled by fillPersonNames for override rows; the scan log selects no embed for it. */
  recorder?: { full_name: string | null } | null;
  zone: { code: string; name: string } | null;
  credential: {
    credential_number: string;
    holder_person_id: string | null;
    holder: { full_name: string | null } | null;
    category: { code: string; project_id: string; project: { project_key: string } | null } | null;
  } | null;
}

const SCAN_COLUMNS = [
  "id, credential_id, zone_id, scanned_at, result, direction, refusal_reason, override_of_scan_id, override_reason, created_by, zone:zones(code, name)",
  "credential:credentials!inner(credential_number, holder_person_id, holder:people!credentials_holder_person_id_fkey(full_name), category:credential_categories!inner(code, project_id, project:projects!credential_categories_project_id_fkey(project_key)))",
].join(", ");

function toScan(row: ScanRow): AccessScan {
  return {
    id: row.id,
    credentialId: row.credential_id,
    credentialNumber: row.credential?.credential_number ?? "",
    holderName: row.credential?.holder?.full_name ?? null,
    categoryCode: row.credential?.category?.code ?? "",
    projectKey: row.credential?.category?.project?.project_key ?? "",
    zoneId: row.zone_id,
    zoneCode: row.zone?.code ?? "",
    zoneName: row.zone?.name ?? "",
    scannedAt: row.scanned_at,
    result: row.result,
    direction: row.direction ?? "In",
    refusalReason: row.refusal_reason ?? null,
    overrideOfScanId: row.override_of_scan_id ?? null,
    overrideReason: row.override_reason ?? null,
    createdBy: row.created_by ?? null,
    createdByName: row.recorder?.full_name ?? null,
  };
}

export interface ScanFilter {
  readonly orgId: string;
  readonly projectId?: string;
  readonly credentialId?: string;
  readonly result?: ScanResult;
  readonly direction?: ScanDirection;
  /** At most this many scans, newest first. */
  readonly limit?: number;
}

/** The scan log, newest first. */
export async function listAccessScans(
  db: XosClient,
  filter: ScanFilter,
): Promise<Result<AccessScan[]>> {
  let query = untyped(db).from("access_scans").select(SCAN_COLUMNS).eq("org_id", filter.orgId);
  if (filter.projectId) query = query.eq("credential.category.project_id", filter.projectId);
  if (filter.credentialId) query = query.eq("credential_id", filter.credentialId);
  if (filter.result) query = query.eq("result", filter.result);
  if (filter.direction) query = query.eq("direction", filter.direction);
  const { data, error } = await query
    .order("scanned_at", { ascending: false })
    .limit(filter.limit ?? 500);
  if (error) return fail(toDataError(error));
  const scans = data as unknown as ScanRow[];
  const named = await fillPersonNames(
    db,
    scans,
    (r) => r.credential?.holder_person_id,
    (r) => r.credential?.holder?.full_name,
    (r, full_name) =>
      r.credential ? { ...r, credential: { ...r.credential, holder: { full_name } } } : r,
  );
  const recorded = await fillPersonNames(
    db,
    named,
    (r) => (r.override_of_scan_id ? r.created_by : null),
    (r) => r.recorder?.full_name,
    (r, full_name) => ({ ...r, recorder: { full_name } }),
  );
  return ok(recorded.map(toScan));
}

export interface RecordScanInput {
  readonly zoneId: string;
  /** The credential scanned: its id, or the number printed on the badge. */
  readonly credentialId?: string;
  readonly credentialNumber?: string;
  /** A client UUIDv7 that becomes the row id, so an offline replay returns the stored scan. */
  readonly id?: string;
  /** When the device scanned, for a scan queued offline. */
  readonly deviceAt?: string;
  /** What the device decided offline; the database decides again and its result stands. */
  readonly offlineResult?: ScanResult;
  /** In unless stated (2970); an Out scan is never refused. */
  readonly direction?: ScanDirection;
}

export interface ScanDecision {
  readonly id: string;
  readonly credentialId: string;
  readonly credentialNumber: string;
  readonly holderName: string | null;
  readonly categoryCode: string;
  readonly zoneId: string;
  readonly zoneCode: string;
  readonly scannedAt: string;
  readonly result: ScanResult;
  /** True when this call replayed a scan already stored under the same client id. */
  readonly replayed: boolean;
  readonly direction: ScanDirection;
  readonly refusalReason: ScanRefusalReason | null;
}

interface ScanDecisionRow {
  id: string;
  credential_id: string;
  credential_number: string;
  holder_name: string | null;
  category_code: string | null;
  zone_id: string;
  zone_code: string;
  scanned_at: string;
  result: ScanResult;
  replayed: boolean;
  direction: ScanDirection | null;
  refusal_reason: ScanRefusalReason | null;
  overridden_scan_id?: string | null;
}

function toDecision(row: ScanDecisionRow): ScanDecision {
  return {
    id: row.id,
    credentialId: row.credential_id,
    credentialNumber: row.credential_number,
    holderName: row.holder_name,
    categoryCode: row.category_code ?? "",
    zoneId: row.zone_id,
    zoneCode: row.zone_code,
    scannedAt: row.scanned_at,
    result: row.result,
    replayed: row.replayed,
    direction: row.direction ?? "In",
    refusalReason: row.refusal_reason ?? null,
  };
}

/**
 * Records a scan at a zone through app.record_scan. The database sets the time and decides the
 * result from the credential's validity, revocation and the access grid; the scanner never sends a
 * result. An unknown code is refused as `credential_unknown`; replaying a client id returns the
 * stored scan with `replayed`.
 */
export async function recordScan(
  db: XosClient,
  input: RecordScanInput,
): Promise<Result<ScanDecision>> {
  const { data, error } = await untyped(db).rpc("record_scan", {
    p_zone_id: input.zoneId,
    ...(input.credentialId ? { p_credential_id: input.credentialId } : {}),
    ...(input.credentialNumber ? { p_credential_number: input.credentialNumber } : {}),
    ...(input.id ? { p_id: input.id } : {}),
    ...(input.deviceAt ? { p_device_scanned_at: input.deviceAt } : {}),
    ...(input.offlineResult ? { p_offline_result: input.offlineResult } : {}),
    ...(input.direction ? { p_direction: input.direction } : {}),
  });
  if (error) return fail(toDataError(error));
  const row = (data as ScanDecisionRow[] | null)?.[0];
  if (!row) return fail({ kind: "not-found" });
  return ok(toDecision(row));
}

export interface OverrideScanInput {
  /** The denied In scan, by its id (Compass's client id of the denied record_scan). */
  readonly scanId: string;
  /** Why the supervisor lets the person in, 1 to 300 characters. */
  readonly reason: string;
  /** A client UUIDv7 that becomes the override row's id, so a queued replay returns it. */
  readonly id?: string;
}

/**
 * Lets in someone the gate denied (app.override_access_scan, 2970; ADR 0147 decision 1): a new Granted In row tied to
 * the denied scan, for a holder of credentials.credential.issue who is not the badge's holder, within 15 minutes and
 * once. Refusals: scan_not_denied, scan_override_revoked, scan_override_stale, scan_override_taken,
 * scan_override_self, scan_override_reason, scan_id_taken.
 */
export async function overrideScan(
  db: XosClient,
  input: OverrideScanInput,
): Promise<Result<ScanDecision & { overriddenScanId: string }>> {
  const { data, error } = await untyped(db).rpc("override_access_scan", {
    p_scan_id: input.scanId,
    p_reason: input.reason,
    ...(input.id ? { p_id: input.id } : {}),
  });
  if (error) return fail(toDataError(error));
  const row = (data as ScanDecisionRow[] | null)?.[0];
  if (!row) return fail({ kind: "not-found" });
  return ok({ ...toDecision(row), overriddenScanId: row.overridden_scan_id ?? input.scanId });
}

// Accreditation checks (B8, migrations 2972 and 2973) ---------------------------------------------

/** A training course or a certification a category requires before it is issued (G-148, ADR 0147 decision 4). */
export interface CategoryRequirement {
  readonly id: string;
  readonly categoryId: string;
  readonly trainingCourseId: string | null;
  readonly certificationId: string | null;
  readonly title: string;
}

/** The live requirements of a category, read through row level security (credentials.credential.read). */
export async function listCategoryRequirements(
  db: XosClient,
  categoryId: string,
): Promise<Result<CategoryRequirement[]>> {
  const { data, error } = await untyped(db)
    .from("credential_category_requirements")
    .select(
      "id, credential_category_id, training_course_id, certification_id, course:training_courses(title), certification:certifications(name)",
    )
    .eq("credential_category_id", categoryId)
    .is("deleted_at", null)
    .order("created_at");
  if (error) return fail(toDataError(error));
  const rows = data as unknown as {
    id: string;
    credential_category_id: string;
    training_course_id: string | null;
    certification_id: string | null;
    course: { title: string } | null;
    certification: { name: string } | null;
  }[];
  return ok(
    rows.map((r) => ({
      id: r.id,
      categoryId: r.credential_category_id,
      trainingCourseId: r.training_course_id,
      certificationId: r.certification_id,
      title: r.course?.title ?? r.certification?.name ?? "",
    })),
  );
}

/** Requires a course or a certification before the category is issued (credentials.category.write). */
export async function addCategoryRequirement(
  db: XosClient,
  input: {
    readonly categoryId: string;
    readonly trainingCourseId?: string;
    readonly certificationId?: string;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await untyped(db)
    .from("credential_category_requirements")
    .insert({
      credential_category_id: input.categoryId,
      training_course_id: input.trainingCourseId ?? null,
      certification_id: input.certificationId ?? null,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Removes a requirement; credentials already issued are untouched. */
export async function removeCategoryRequirement(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await untyped(db)
    .from("credential_category_requirements")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return fail(toDataError(error));
  return ok(null);
}

export type IssueCheckCode =
  | "training_missing"
  | "training_expires_first"
  | "duplicate"
  | "other_badge_on_project"
  | "same_name_on_project"
  | "booked_elsewhere";

/** One line of what the issue form shows before Issue (app.credential_issue_check). */
export interface IssueCheck {
  readonly code: IssueCheckCode;
  /** True for an unmet requirement and a duplicate: Issue stays disabled. */
  readonly blocking: boolean;
  readonly requirementId: string | null;
  readonly title: string | null;
  readonly otherCredentialId: string | null;
  /** The other project, only when the caller can read it; else "another production". */
  readonly projectId: string | null;
  readonly projectKey: string | null;
}

export async function credentialIssueCheck(
  db: XosClient,
  input: {
    readonly categoryId: string;
    readonly holderPersonId: string;
    readonly validFrom?: string | null;
    readonly validTo?: string | null;
  },
): Promise<Result<IssueCheck[]>> {
  const { data, error } = await untyped(db).rpc("credential_issue_check", {
    p_category_id: input.categoryId,
    p_holder_person_id: input.holderPersonId,
    ...(input.validFrom ? { p_valid_from: input.validFrom } : {}),
    ...(input.validTo ? { p_valid_to: input.validTo } : {}),
  });
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as {
    check_code: IssueCheckCode;
    blocking: boolean;
    requirement_id: string | null;
    title: string | null;
    other_credential_id: string | null;
    project_id: string | null;
    project_key: string | null;
  }[];
  return ok(
    rows.map((r) => ({
      code: r.check_code,
      blocking: r.blocking,
      requirementId: r.requirement_id,
      title: r.title,
      otherCredentialId: r.other_credential_id,
      projectId: r.project_id,
      projectKey: r.project_key,
    })),
  );
}

export type HolderSource = "Allocation" | "Engagement" | "Member" | "Direct";

/** The accreditation checks of one credential (app.credential_review, 2973), as the Issued page's chips show them. */
export interface CredentialReview {
  readonly credentialId: string;
  readonly holderSource: HolderSource;
  readonly otherBadgesOnProject: number;
  readonly sameNameOnProject: number;
  readonly duplicateLive: boolean;
  readonly missingRequirements: number;
  readonly bookedElsewhere: boolean;
}

/** True when any check flags the credential: the Issued page's "Needs attention" filter. */
export function needsAttention(review: CredentialReview): boolean {
  return (
    review.duplicateLive ||
    review.missingRequirements > 0 ||
    review.otherBadgesOnProject > 0 ||
    review.sameNameOnProject > 0 ||
    review.bookedElsewhere
  );
}

/** The review rows of the listed credentials (at most 500, a page's worth), in one call. */
export async function credentialReviews(
  db: XosClient,
  credentialIds: readonly string[],
): Promise<Result<Map<string, CredentialReview>>> {
  if (credentialIds.length === 0) return ok(new Map());
  const { data, error } = await untyped(db).rpc("credential_review", {
    p_credential_ids: [...credentialIds].slice(0, 500),
  });
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as {
    credential_id: string;
    holder_source: HolderSource;
    other_badges_on_project: number;
    same_name_on_project: number;
    duplicate_live: boolean;
    missing_requirements: number;
    booked_elsewhere: boolean;
  }[];
  return ok(
    new Map(
      rows.map((r) => [
        r.credential_id,
        {
          credentialId: r.credential_id,
          holderSource: r.holder_source,
          otherBadgesOnProject: r.other_badges_on_project,
          sameNameOnProject: r.same_name_on_project,
          duplicateLive: r.duplicate_live,
          missingRequirements: r.missing_requirements,
          bookedElsewhere: r.booked_elsewhere,
        },
      ]),
    ),
  );
}

export interface BookingElsewhere {
  readonly projectId: string | null;
  readonly projectKey: string | null;
  readonly kind: "Credential" | "Engagement";
  readonly startsAt: string | null;
  readonly endsAt: string | null;
}

/** Where else in the org the holder is booked during the credential's window (app.credential_bookings_elsewhere). */
export async function credentialBookingsElsewhere(
  db: XosClient,
  credentialId: string,
): Promise<Result<BookingElsewhere[]>> {
  const { data, error } = await untyped(db).rpc("credential_bookings_elsewhere", {
    p_credential_id: credentialId,
  });
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as {
    project_id: string | null;
    project_key: string | null;
    kind: "Credential" | "Engagement";
    starts_at: string | null;
    ends_at: string | null;
  }[];
  return ok(
    rows.map((r) => ({
      projectId: r.project_id,
      projectKey: r.project_key,
      kind: r.kind,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
    })),
  );
}

// Live counts (B8, migration 2971) ---------------------------------------------------------------

/** People scanned into a zone now, by category and engagement (app.zone_counts_live); the rows of a zone sum to its total. */
export interface ZoneCount {
  readonly zoneId: string;
  readonly credentialCategoryId: string | null;
  readonly engagementId: string | null;
  readonly inside: number;
  readonly lastEntryAt: string | null;
}

export async function zoneCountsLive(
  db: XosClient,
  projectId: string,
): Promise<Result<ZoneCount[]>> {
  const { data, error } = await untyped(db)
    .from("zone_counts_live")
    .select("zone_id, credential_category_id, engagement_id, inside, last_entry_at")
    .eq("project_id", projectId);
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as {
    zone_id: string;
    credential_category_id: string | null;
    engagement_id: string | null;
    inside: number;
    last_entry_at: string | null;
  }[];
  return ok(
    rows.map((r) => ({
      zoneId: r.zone_id,
      credentialCategoryId: r.credential_category_id,
      engagementId: r.engagement_id,
      inside: r.inside,
      lastEntryAt: r.last_entry_at,
    })),
  );
}

/** Zone totals from the live counts, for the Inside now section and Compass's gate screen. */
export function zoneTotals(counts: readonly ZoneCount[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const c of counts) totals.set(c.zoneId, (totals.get(c.zoneId) ?? 0) + c.inside);
  return totals;
}

// Capabilities ---------------------------------------------------------------------------------

/** Every credentials and safety capability the module pages offer controls for. */
export const MODULE_CAPABILITIES = [
  "credentials.credential.read",
  "credentials.category.write",
  "credentials.access_grid.write",
  "credentials.credential.issue",
  "credentials.credential.revoke",
  "credentials.scan.write",
  "credentials.scan_log.read",
  "safety.incident.read",
  "safety.incident.write",
  "safety.incident.dispatch",
  "safety.incident.close",
  "safety.radio_channel.write",
  "data.restricted.read.medical",
] as const;
export type ModuleCapability = (typeof MODULE_CAPABILITIES)[number];

/**
 * Which module capabilities the signed-in person may use on a project
 * (app.my_capabilities_on_project, migration 0470). It only decides which controls to show; the
 * database still decides each write.
 */
export async function myModuleCapabilities(
  db: XosClient,
  projectId: string,
): Promise<Result<ReadonlySet<ModuleCapability>>> {
  const { data, error } = await db.rpc("my_capabilities_on_project", {
    p_project_id: projectId,
    p_capabilities: [...MODULE_CAPABILITIES],
  });
  if (error) return fail(toDataError(error));
  return ok(new Set((data ?? []) as ModuleCapability[]));
}
