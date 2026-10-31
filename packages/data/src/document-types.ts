import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Document types (B14, G-266, migration 3031, ADR 0153 decision D3): the kinds of project document an org files, such
 * as a site plan or an insurance certificate. Event types name the ones a project needs (event-types.ts), and the gate
 * checks them (3032). Read by the org's members; written with projects.template.write. A type a live requirement
 * names is not deleted (document_type_in_use).
 */

export interface DocumentType {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** The XOS Standard Library DOCUMENT TYPE it was added from; null for the org's own. */
  readonly standardType: string | null;
}

interface Row {
  id: string;
  name: string;
  description: string | null;
  std_document_type: string | null;
}

/** The org's live document types, by name. */
export async function listDocumentTypes(
  db: XosClient,
  orgId: string,
): Promise<Result<DocumentType[]>> {
  const { data, error } = await untyped(db)
    .from("document_types")
    .select("id, name, description, std_document_type")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(
    (data as Row[]).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      standardType: r.std_document_type,
    })),
  );
}

/** Adds a document type, or renames and redescribes one. */
export async function saveDocumentType(
  db: XosClient,
  input: {
    readonly id?: string;
    readonly orgId: string;
    readonly name: string;
    readonly description?: string | null;
  },
): Promise<Result<{ id: string }>> {
  const row = {
    name: input.name.trim(),
    description: input.description?.trim() ? input.description.trim() : null,
  };
  const query = input.id
    ? untyped(db)
        .from("document_types")
        .update(row)
        .eq("id", input.id)
        .is("deleted_at", null)
        .select("id")
    : untyped(db)
        .from("document_types")
        .insert({ ...row, org_id: input.orgId })
        .select("id");
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  const first = (data as { id: string }[] | null)?.[0];
  return first ? ok({ id: first.id }) : fail({ kind: "not-found" });
}

/** Moves a document type to Trash; refused with document_type_in_use while a requirement names it. */
export async function removeDocumentType(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await untyped(db)
    .from("document_types")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return (data as unknown[] | null)?.length ? ok(null) : fail({ kind: "not-found" });
}

/**
 * Adds one type per distinct XOS Standard Library DOCUMENT TYPE the org does not hold yet
 * (app.adopt_standard_document_types); a second run adds nothing. Returns how many it added.
 */
export async function adoptStandardDocumentTypes(
  db: XosClient,
  orgId: string,
): Promise<Result<number>> {
  const { data, error } = await untyped(db).rpc("adopt_standard_document_types", {
    p_org_id: orgId,
  });
  if (error) return fail(toDataError(error));
  return ok(typeof data === "number" ? data : 0);
}
