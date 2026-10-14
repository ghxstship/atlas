import type { XosClient } from "./client";
import { fail, ok, toDataError, type DatabaseErrorLike, type Result } from "./result";

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
}

interface ProjectRow {
  id: string;
  project_key: string;
  name: string;
  venue_id: string | null;
}

const PROJECT_COLUMNS = "id, project_key, name, venue_id";

function toProject(row: ProjectRow): OperationsProject {
  return { id: row.id, key: row.project_key, name: row.name, venueId: row.venue_id };
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
}

/**
 * Zones a project works in: the zones of its venue, or every zone of the org the viewer may read
 * when the project has no venue yet. Listed in code order (Section 3.6, numeric order).
 */
export async function listProjectZones(
  db: XosClient,
  orgId: string,
  venueId: string | null,
): Promise<Result<Zone[]>> {
  let query = db
    .from("zones")
    .select("id, code, name, venue_id")
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (venueId !== null) query = query.eq("venue_id", venueId);
  const { data, error } = await query.order("code");
  if (error) return fail(toDataError(error));
  return ok(data.map((z) => ({ id: z.id, code: z.code, name: z.name, venueId: z.venue_id })));
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
  /** Credentials of this category that are not revoked. */
  readonly activeCount: number;
}

interface CategoryRow {
  id: string;
  project_id: string;
  code: string;
  name: string;
  project: { project_key: string } | null;
  credentials: { revoked_at: string | null; deleted_at: string | null }[] | null;
}

const CATEGORY_COLUMNS =
  "id, project_id, code, name, project:projects!credential_categories_project_id_fkey(project_key), credentials(revoked_at, deleted_at)";

function toCategory(row: CategoryRow): CredentialCategory {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project?.project_key ?? "",
    code: row.code,
    name: row.name,
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
    .update({ code: input.code.trim().toUpperCase(), name: input.name.trim() })
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
  return ok((data as unknown as CredentialRow[]).map(toCredential));
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
  return ok(toCredential(data as unknown as CredentialRow));
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
  return ok(toCredential(data as unknown as CredentialRow));
}

export interface IssueCredentialInput {
  readonly orgId: string;
  readonly categoryId: string;
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
      credential_category_id: input.categoryId,
      holder_person_id: input.holderPersonId,
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
}

interface ScanRow {
  id: string;
  credential_id: string;
  zone_id: string;
  scanned_at: string;
  result: ScanResult;
  zone: { code: string; name: string } | null;
  credential: {
    credential_number: string;
    holder: { full_name: string | null } | null;
    category: { code: string; project_id: string; project: { project_key: string } | null } | null;
  } | null;
}

const SCAN_COLUMNS = [
  "id, credential_id, zone_id, scanned_at, result, zone:zones(code, name)",
  "credential:credentials!inner(credential_number, holder:people!credentials_holder_person_id_fkey(full_name), category:credential_categories!inner(code, project_id, project:projects!credential_categories_project_id_fkey(project_key)))",
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
  };
}

export interface ScanFilter {
  readonly orgId: string;
  readonly projectId?: string;
  readonly credentialId?: string;
  readonly result?: ScanResult;
  /** At most this many scans, newest first. */
  readonly limit?: number;
}

/** The scan log, newest first. */
export async function listAccessScans(
  db: XosClient,
  filter: ScanFilter,
): Promise<Result<AccessScan[]>> {
  let query = db.from("access_scans").select(SCAN_COLUMNS).eq("org_id", filter.orgId);
  if (filter.projectId) query = query.eq("credential.category.project_id", filter.projectId);
  if (filter.credentialId) query = query.eq("credential_id", filter.credentialId);
  if (filter.result) query = query.eq("result", filter.result);
  const { data, error } = await query
    .order("scanned_at", { ascending: false })
    .limit(filter.limit ?? 500);
  if (error) return fail(toDataError(error));
  return ok((data as unknown as ScanRow[]).map(toScan));
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
}

/** An RPC of migration 0470, typed here until the generated database types carry it. */
type LocalRpc<Args, Row> = (
  fn: string,
  args: Args,
) => PromiseLike<{ data: Row | null; error: DatabaseErrorLike | null }>;

export function localRpc<Args, Row>(db: XosClient): LocalRpc<Args, Row> {
  return db.rpc.bind(db) as unknown as LocalRpc<Args, Row>;
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
  const rpc = localRpc<Record<string, string | null>, ScanDecisionRow[]>(db);
  const { data, error } = await rpc("record_scan", {
    p_zone_id: input.zoneId,
    p_credential_id: input.credentialId ?? null,
    p_credential_number: input.credentialNumber ?? null,
    p_id: input.id ?? null,
    p_device_scanned_at: input.deviceAt ?? null,
    p_offline_result: input.offlineResult ?? null,
  });
  if (error) return fail(toDataError(error));
  const row = data?.[0];
  if (!row) return fail({ kind: "not-found" });
  return ok({
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
  });
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
  const rpc = localRpc<{ p_project_id: string; p_capabilities: string[] }, string[]>(db);
  const { data, error } = await rpc("my_capabilities_on_project", {
    p_project_id: projectId,
    p_capabilities: [...MODULE_CAPABILITIES],
  });
  if (error) return fail(toDataError(error));
  return ok(new Set((data ?? []) as ModuleCapability[]));
}
