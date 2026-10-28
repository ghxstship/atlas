import { applyArchived, type ArchivedFilter } from "./archive.ts";
import type { Database, XosClient } from "./client.ts";
import {
  blankToNull,
  deletedNow,
  insertedId,
  readOne,
  readRows,
  touched,
} from "./commercial-common.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Knowledge repository (Section 4.2 Knowledge, Section 7.4, invariant 24): SOPs with versioned
 * publishing and acknowledgments, documents with append-only versions, and the verbiage library
 * (migration 0353). The database raises the SOP version on publish, stamps acknowledgments with the
 * current version and refuses em dashes in verbiage.
 */

type Tables = Database["app"]["Tables"];

/** Em dash (U+2014), refused in every verbiage text by invariant 24. */
export const EM_DASH = String.fromCharCode(0x2014);

// SOPs ---------------------------------------------------------------------------------------------

export type SopStanding = "draft" | "published";

export interface Sop {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly body: string;
  readonly version: number;
  readonly publishedAt: string | null;
  readonly updatedAt: string;
  /** Whether the signed-in person acknowledged the current published version. */
  readonly acknowledgedByMe: boolean;
  /** Acknowledgments of the current version (visible to SOP editors; otherwise the person's own). */
  readonly currentAcknowledgments: number;
}

export function sopStanding(sop: Pick<Sop, "publishedAt">): SopStanding {
  return sop.publishedAt === null ? "draft" : "published";
}

/** A published SOP changed after publishing has unpublished edits waiting for the next version. */
export function hasUnpublishedChanges(sop: Pick<Sop, "publishedAt" | "updatedAt">): boolean {
  return sop.publishedAt !== null && Date.parse(sop.updatedAt) - Date.parse(sop.publishedAt) > 1000;
}

const SOP_COLUMNS =
  "id, code, title, body, version, published_at, updated_at, sop_acknowledgments(person_id, sop_version)" as const;

interface SopRow {
  id: string;
  code: string;
  title: string;
  body: string;
  version: number;
  published_at: string | null;
  updated_at: string;
  sop_acknowledgments: { person_id: string; sop_version: number }[] | null;
}

function toSop(row: SopRow, personId: string | null): Sop {
  const current = (row.sop_acknowledgments ?? []).filter(
    (a) => row.published_at !== null && a.sop_version === row.version,
  );
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    body: row.body,
    version: row.version,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    acknowledgedByMe: personId !== null && current.some((a) => a.person_id === personId),
    currentAcknowledgments: current.length,
  };
}

/** SOPs of the org in code order (Section 7.4). */
export async function listSops(
  db: XosClient,
  orgId: string,
  personId: string | null,
): Promise<Result<Sop[]>> {
  return readRows(
    db.from("sops").select(SOP_COLUMNS).eq("org_id", orgId).is("deleted_at", null).order("code"),
    (row) => toSop(row as SopRow, personId),
  );
}

export async function getSop(
  db: XosClient,
  id: string,
  personId: string | null,
): Promise<Result<Sop>> {
  return readOne(
    db.from("sops").select(SOP_COLUMNS).eq("id", id).is("deleted_at", null).maybeSingle(),
    (row) => toSop(row as SopRow, personId),
  );
}

/** The next free SOP-NNN code of the org. */
export function nextSopCode(existing: readonly string[]): string {
  const numbers = existing
    .map((c) => /^SOP-([0-9]{3,5})$/.exec(c)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  return `SOP-${String(next).padStart(3, "0")}`;
}

export interface SopInput {
  readonly code: string;
  readonly title: string;
  readonly body: string;
}

/** Creates a draft SOP. */
export async function createSop(
  db: XosClient,
  orgId: string,
  input: SopInput,
): Promise<Result<{ id: string }>> {
  return insertedId(
    db
      .from("sops")
      .insert({
        org_id: orgId,
        code: input.code.trim().toUpperCase(),
        title: input.title.trim(),
        body: input.body,
      })
      .select("id")
      .single(),
  );
}

/**
 * Edits an SOP's title and body. `expectedUpdatedAt` is the version the editor loaded: when someone
 * saved in between, the update touches no row and comes back as a conflict, so no edit is lost
 * silently.
 */
export async function updateSop(
  db: XosClient,
  id: string,
  input: Omit<SopInput, "code"> & { readonly expectedUpdatedAt: string },
): Promise<Result<null>> {
  const { data, error } = await db
    .from("sops")
    .update({ title: input.title.trim(), body: input.body })
    .eq("id", id)
    .eq("updated_at", input.expectedUpdatedAt)
    .select("id");
  if (error) return fail(toDataError(error));
  if (data.length > 0) return ok(null);
  const exists = await readOne(
    db.from("sops").select("id").eq("id", id).is("deleted_at", null).maybeSingle(),
    (row) => row.id,
  );
  return exists.ok ? fail({ kind: "conflict", message: "sop_edited_elsewhere" }) : exists;
}

/** Publishes the SOP: the database raises the version and asks everyone to acknowledge again. */
export async function publishSop(
  db: XosClient,
  id: string,
  now: Date = new Date(),
): Promise<Result<null>> {
  return touched(
    db.from("sops").update({ published_at: now.toISOString() }).eq("id", id).select("id"),
  );
}

export async function deleteSop(db: XosClient, id: string): Promise<Result<null>> {
  return touched(db.from("sops").update(deletedNow()).eq("id", id).select("id"));
}

/** The signed-in person acknowledges the current published version. */
export async function acknowledgeSop(
  db: XosClient,
  sopId: string,
  personId: string,
): Promise<Result<{ id: string }>> {
  const row = { sop_id: sopId, person_id: personId } as Tables["sop_acknowledgments"]["Insert"];
  return insertedId(db.from("sop_acknowledgments").insert(row).select("id").single());
}

export interface SopAcknowledgment {
  readonly personId: string;
  readonly personName: string | null;
  readonly version: number;
  readonly acknowledgedAt: string;
}

/** Acknowledgments of an SOP, newest first (all of them for editors; otherwise the person's own). */
export async function listSopAcknowledgments(
  db: XosClient,
  sopId: string,
): Promise<Result<SopAcknowledgment[]>> {
  return readRows(
    db
      .from("sop_acknowledgments")
      .select(
        "person_id, sop_version, acknowledged_at, person:people!sop_acknowledgments_person_id_fkey(full_name)",
      )
      .eq("sop_id", sopId)
      .order("acknowledged_at", { ascending: false }),
    (row) => ({
      personId: row.person_id,
      personName: row.person?.full_name ?? null,
      version: row.sop_version,
      acknowledgedAt: row.acknowledged_at,
    }),
  );
}

/** Standard Library SOPs an org may adopt (xpms.std_sop). */
export async function listStandardSops(
  db: XosClient,
): Promise<Result<{ id: string; title: string; body: string }[]>> {
  return readRows(
    db
      .schema("xpms")
      .from("std_sop")
      .select(
        "sop_id, title, prerequisites_and_hazards, procedure_step_1, procedure_step_2, procedure_step_3, procedure_step_4",
      )
      .order("source_row"),
    (row) => ({
      id: row.sop_id,
      title: row.title ?? row.sop_id,
      body: [
        row.prerequisites_and_hazards,
        row.procedure_step_1,
        row.procedure_step_2,
        row.procedure_step_3,
        row.procedure_step_4,
      ]
        .filter((part): part is string => Boolean(part))
        .join("\n\n"),
    }),
  );
}

// Documents --------------------------------------------------------------------------------------------

export interface DocumentVersion {
  readonly id: string;
  readonly versionNumber: number;
  readonly storageUri: string;
  readonly checksumSha256: string;
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly createdByName: string | null;
}

export interface KnowledgeDocument {
  readonly id: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly projectKey: string | null;
  readonly updatedAt: string;
  readonly versions: readonly DocumentVersion[];
  readonly latestVersion: DocumentVersion | null;
  /** When the document was archived (A124); archived documents leave lists unless asked for. */
  readonly archivedAt: string | null;
}

const DOCUMENT_COLUMNS =
  "id, title, project_id, updated_at, archived_at, project:projects(project_key), document_versions(id, version_number, storage_uri, checksum_sha256, created_at, created_by, author:people!document_versions_created_by_fkey(full_name))" as const;

interface DocumentRow {
  id: string;
  title: string;
  project_id: string | null;
  updated_at: string;
  archived_at: string | null;
  project: { project_key: string } | null;
  document_versions:
    | {
        id: string;
        version_number: number;
        storage_uri: string;
        checksum_sha256: string;
        created_at: string;
        created_by: string | null;
        author: { full_name: string | null } | null;
      }[]
    | null;
}

function toDocument(row: DocumentRow): KnowledgeDocument {
  const versions = (row.document_versions ?? [])
    .map((v) => ({
      id: v.id,
      versionNumber: v.version_number,
      storageUri: v.storage_uri,
      checksumSha256: v.checksum_sha256,
      createdAt: v.created_at,
      createdBy: v.created_by,
      createdByName: v.author?.full_name ?? null,
    }))
    .sort((a, b) => b.versionNumber - a.versionNumber);
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    projectKey: row.project?.project_key ?? null,
    updatedAt: row.updated_at,
    versions,
    latestVersion: versions[0] ?? null,
    archivedAt: row.archived_at,
  };
}

/**
 * Org-wide documents and documents of the projects the viewer can read, latest change first;
 * archived ones only when asked for (A124).
 */
export async function listDocuments(
  db: XosClient,
  orgId: string,
  archived: ArchivedFilter = "exclude",
): Promise<Result<KnowledgeDocument[]>> {
  const result = await readRows(
    applyArchived(
      db.from("documents").select(DOCUMENT_COLUMNS).eq("org_id", orgId).is("deleted_at", null),
      archived,
    ).order("updated_at", { ascending: false }),
    (row) => toDocument(row),
  );
  return result.ok
    ? ok(result.data.sort((a, b) => lastChange(b).localeCompare(lastChange(a))))
    : result;
}

/** When a document last changed: its newest version, or the document row itself. */
export function lastChange(doc: Pick<KnowledgeDocument, "updatedAt" | "latestVersion">): string {
  const version = doc.latestVersion?.createdAt;
  return version !== undefined && version > doc.updatedAt ? version : doc.updatedAt;
}

export async function getDocument(db: XosClient, id: string): Promise<Result<KnowledgeDocument>> {
  return readOne(
    db.from("documents").select(DOCUMENT_COLUMNS).eq("id", id).is("deleted_at", null).maybeSingle(),
    (row) => toDocument(row),
  );
}

const SHA256 = /^[0-9a-f]{64}$/;

export interface DocumentVersionInput {
  readonly storageUri: string;
  readonly checksumSha256: string;
}

/** Creates a document with its first version. */
export async function createDocument(
  db: XosClient,
  orgId: string,
  input: { readonly title: string; readonly projectId: string | null } & DocumentVersionInput,
): Promise<Result<{ id: string }>> {
  if (!SHA256.test(input.checksumSha256)) return fail({ kind: "invalid", message: "checksum" });
  const document = await insertedId(
    db
      .from("documents")
      .insert({
        org_id: orgId,
        title: input.title.trim(),
        project_id: blankToNull(input.projectId),
      })
      .select("id")
      .single(),
  );
  if (!document.ok) return document;
  const version = await addDocumentVersion(db, document.data.id, input);
  return version.ok ? document : version;
}

export async function renameDocument(
  db: XosClient,
  id: string,
  title: string,
): Promise<Result<null>> {
  return touched(db.from("documents").update({ title: title.trim() }).eq("id", id).select("id"));
}

/** Appends a version; the database numbers it and versions never change. */
export async function addDocumentVersion(
  db: XosClient,
  documentId: string,
  input: DocumentVersionInput,
): Promise<Result<{ id: string }>> {
  if (!SHA256.test(input.checksumSha256)) return fail({ kind: "invalid", message: "checksum" });
  const row = {
    document_id: documentId,
    storage_uri: input.storageUri.trim(),
    checksum_sha256: input.checksumSha256,
  } as Tables["document_versions"]["Insert"];
  return insertedId(db.from("document_versions").insert(row).select("id").single());
}

export async function deleteDocument(db: XosClient, id: string): Promise<Result<null>> {
  return touched(db.from("documents").update(deletedNow()).eq("id", id).select("id"));
}

// Verbiage library ---------------------------------------------------------------------------------------

export interface VerbiageTerm {
  readonly id: string;
  readonly term: string;
  readonly casingRule: string;
  readonly definition: string;
}

export async function listVerbiageTerms(
  db: XosClient,
  orgId: string,
): Promise<Result<VerbiageTerm[]>> {
  const result = await readRows(
    db
      .from("verbiage_terms")
      .select("id, term, casing_rule, definition")
      .eq("org_id", orgId)
      .is("deleted_at", null),
    (row) => ({
      id: row.id,
      term: row.term,
      casingRule: row.casing_rule,
      definition: row.definition,
    }),
  );
  return result.ok ? ok(result.data.sort((a, b) => a.term.localeCompare(b.term))) : result;
}

export interface VerbiageInput {
  readonly term: string;
  readonly casingRule: string;
  readonly definition: string;
}

export type VerbiageProblem = "em_dash" | "definition_sentence" | "term_length";

/** The rules the database enforces on verbiage (invariant 24), checked before the round trip. */
export function verbiageProblems(input: VerbiageInput): VerbiageProblem[] {
  const problems: VerbiageProblem[] = [];
  const term = input.term.trim();
  if (term.length < 1 || term.length > 200) problems.push("term_length");
  if ([input.term, input.casingRule, input.definition].some((t) => t.includes(EM_DASH))) {
    problems.push("em_dash");
  }
  if (!input.definition.trim().endsWith(".")) problems.push("definition_sentence");
  return problems;
}

function verbiageRow(input: VerbiageInput) {
  return {
    term: input.term.trim(),
    casing_rule: input.casingRule.trim(),
    definition: input.definition.trim(),
  };
}

export async function createVerbiageTerm(
  db: XosClient,
  orgId: string,
  input: VerbiageInput,
): Promise<Result<{ id: string }>> {
  return insertedId(
    db
      .from("verbiage_terms")
      .insert({ ...verbiageRow(input), org_id: orgId })
      .select("id")
      .single(),
  );
}

export async function updateVerbiageTerm(
  db: XosClient,
  id: string,
  input: VerbiageInput,
): Promise<Result<null>> {
  return touched(db.from("verbiage_terms").update(verbiageRow(input)).eq("id", id).select("id"));
}

export async function deleteVerbiageTerm(db: XosClient, id: string): Promise<Result<null>> {
  return touched(db.from("verbiage_terms").update(deletedNow()).eq("id", id).select("id"));
}

/** Standard Library verbiage an org may adopt (xpms.std_verbiage). */
export async function listStandardVerbiage(
  db: XosClient,
): Promise<Result<{ id: string; term: string; definition: string | null }[]>> {
  return readRows(
    db
      .schema("xpms")
      .from("std_verbiage")
      .select("record_id, verbiage, title, description")
      .order("source_row"),
    (row) => ({
      id: row.record_id,
      term: row.verbiage ?? row.title ?? row.record_id,
      definition: row.description,
    }),
  );
}
