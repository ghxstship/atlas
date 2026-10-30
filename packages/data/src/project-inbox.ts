import type { XosClient } from "./client.ts";
import type { DatabaseErrorLike } from "./result.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * The project inbox (Section 4.6.5, migrations 0550 and 1411): one live address per project, the
 * mail the inbound-email Edge Function delivers to it, and the coordinator's filing (a Document
 * record of the project, optionally to one of its records) or discard. Every call runs as the
 * caller, so row level security and the guards decide.
 */

export interface ProjectInboxAddress {
  readonly id: string;
  readonly localPart: string;
  readonly createdAt: string;
}

/** The full address once the receiving domain is set up (XOS_INBOUND_DOMAIN), else null. */
export function inboxAddress(localPart: string, domain: string | null | undefined): string | null {
  const d = domain?.trim().toLowerCase();
  return d && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? `${localPart}@${d}` : null;
}

/** The project's live inbox address, or null when it has none. */
export async function getProjectInbox(
  db: XosClient,
  projectId: string,
): Promise<Result<ProjectInboxAddress | null>> {
  const { data, error } = await db
    .from("inbound_addresses")
    .select("id, local_part, created_at")
    .eq("project_id", projectId)
    .is("disabled_at", null)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  return ok(data ? { id: data.id, localPart: data.local_part, createdAt: data.created_at } : null);
}

async function addressCall(
  db: XosClient,
  fn: "create_project_inbox" | "replace_project_inbox" | "disable_project_inbox",
  projectId: string,
): Promise<Result<string | null>> {
  const { data, error } = await (
    db as unknown as {
      rpc(
        f: string,
        a: Record<string, unknown>,
      ): PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>;
    }
  ).rpc(fn, { p_project_id: projectId });
  if (error) return fail(toDataError(error));
  return ok(typeof data === "string" ? data : null);
}

/** The live address, created when the project has none (projects.settings.write). */
export function createProjectInbox(db: XosClient, projectId: string) {
  return addressCall(db, "create_project_inbox", projectId);
}

/** A new address; the old one stops accepting mail. */
export function replaceProjectInbox(db: XosClient, projectId: string) {
  return addressCall(db, "replace_project_inbox", projectId);
}

/** Stops the inbox; mail already received stays. */
export function disableProjectInbox(db: XosClient, projectId: string) {
  return addressCall(db, "disable_project_inbox", projectId);
}

export type InboxItemState = "open" | "rejected" | "filed" | "discarded";

export interface InboxItem {
  readonly id: string;
  readonly fromAddress: string;
  readonly subject: string | null;
  readonly body: string | null;
  readonly receivedAt: string;
  readonly state: InboxItemState;
  readonly rejectionReason: string | null;
  readonly documentId: string | null;
  readonly documentTitle: string | null;
  readonly recordId: string | null;
  readonly recordTitle: string | null;
  readonly filedAt: string | null;
  readonly filedByName: string | null;
  readonly discardedAt: string | null;
  readonly discardedByName: string | null;
  readonly discardReason: string | null;
}

interface MessageRow {
  id: string;
  from_address: string;
  subject_line: string | null;
  body_text: string | null;
  received_at: string;
  inbound_status: string;
  rejection_reason: string | null;
  filed_document_id: string | null;
  filed_record_id: string | null;
  filed_at: string | null;
  discarded_at: string | null;
  discard_reason: string | null;
  filer: { full_name: string | null } | null;
  discarder: { full_name: string | null } | null;
  document: { title: string } | null;
  record: { title: string } | null;
}

function stateOf(row: MessageRow): InboxItemState {
  if (row.discarded_at !== null) return "discarded";
  if (row.filed_document_id !== null) return "filed";
  return row.inbound_status === "Rejected" ? "rejected" : "open";
}

/** Mail delivered to any of the project's inbox addresses, newest first (at most 200). */
export async function listProjectInbox(
  db: XosClient,
  projectId: string,
): Promise<Result<InboxItem[]>> {
  const addresses = await db.from("inbound_addresses").select("id").eq("project_id", projectId);
  if (addresses.error) return fail(toDataError(addresses.error));
  if (addresses.data.length === 0) return ok([]);
  const { data, error } = await db
    .from("inbound_messages")
    .select(
      "id, from_address, subject_line, body_text, received_at, inbound_status, rejection_reason, filed_document_id, filed_record_id, filed_at, discarded_at, discard_reason, filer:people!inbound_messages_filed_by_fkey(full_name), discarder:people!inbound_messages_discarded_by_fkey(full_name), document:documents!inbound_messages_filed_document_id_fkey(title), record:records!inbound_messages_filed_record_id_fkey(title)",
    )
    .in(
      "inbound_address_id",
      addresses.data.map((a) => a.id),
    )
    .is("deleted_at", null)
    .order("received_at", { ascending: false })
    .limit(200);
  if (error) return fail(toDataError(error));
  return ok(
    (data as unknown as MessageRow[]).map((row) => ({
      id: row.id,
      fromAddress: row.from_address,
      subject: row.subject_line,
      body: row.body_text,
      receivedAt: row.received_at,
      state: stateOf(row),
      rejectionReason: row.rejection_reason,
      documentId: row.filed_document_id,
      documentTitle: row.document?.title ?? null,
      recordId: row.filed_record_id,
      recordTitle: row.record?.title ?? null,
      filedAt: row.filed_at,
      filedByName: row.filer?.full_name ?? null,
      discardedAt: row.discarded_at,
      discardedByName: row.discarder?.full_name ?? null,
      discardReason: row.discard_reason,
    })),
  );
}

export interface FileTarget {
  readonly id: string;
  readonly label: string;
}

/** Records of the project the caller can open, newest first, as filing targets (at most 200). */
export async function listFilingTargets(
  db: XosClient,
  projectId: string,
  projectKey: string,
): Promise<Result<FileTarget[]>> {
  const { data, error } = await db
    .from("records")
    .select("id, title, record_number")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .is("archived_at", null)
    .order("record_number", { ascending: false })
    .limit(200);
  if (error) return fail(toDataError(error));
  return ok(data.map((r) => ({ id: r.id, label: `${projectKey}-${r.record_number} ${r.title}` })));
}

/** Files verified mail as a Document record of the project; returns the document id. */
export async function fileInboundMessage(
  db: XosClient,
  input: { readonly id: string; readonly title?: string | null; readonly recordId?: string | null },
): Promise<Result<string>> {
  const { data, error } = await db.rpc("file_inbound_message", {
    p_inbound_message_id: input.id,
    ...(input.title ? { p_title: input.title } : {}),
    ...(input.recordId ? { p_record_id: input.recordId } : {}),
  });
  if (error) return fail(toDataError(error));
  return typeof data === "string"
    ? ok(data)
    : fail({ kind: "unexpected", message: "file_inbound_message returned no document" });
}

/** Discards mail, keeping it with who, when and the reason. */
export async function discardInboundMessage(
  db: XosClient,
  input: { readonly id: string; readonly reason?: string | null },
): Promise<Result<void>> {
  const { error } = await db.rpc("discard_inbound_message", {
    p_inbound_message_id: input.id,
    ...(input.reason ? { p_reason: input.reason } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(undefined);
}
