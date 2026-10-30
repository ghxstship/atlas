import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Files linked in place on a document from Google Drive or OneDrive (B16, migration 3053, ADR 0155 D5; Section 17).
 * Readers of the document list its links through app.document_file_links, which also names each link's provider:
 * they cannot read the org's integration connections. A writer removes a link with a soft delete through the 0625
 * row level security; linking itself runs in the storage-browse Edge Function, which alone reads credentials.
 */

export type LinkProvider = "google_drive" | "onedrive_sharepoint" | "dropbox";

export interface DocumentFileLink {
  readonly linkId: string;
  readonly provider: LinkProvider;
  readonly mode: "Link" | "Import";
  readonly fileName: string;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly webUrl: string | null;
  readonly modifiedAt: string | null;
  readonly linkedAt: string;
}

export interface LinkableConnection {
  readonly connectionId: string;
  readonly provider: "google_drive" | "onedrive_sharepoint";
  readonly displayName: string;
  readonly accountName: string | null;
}

function provider(value: string): LinkProvider {
  return value === "onedrive_sharepoint" || value === "dropbox" ? value : "google_drive";
}

/** app.document_file_links: the document's linked files, for anyone who can read the document. */
export async function listDocumentFileLinks(
  db: XosClient,
  documentId: string,
): Promise<Result<DocumentFileLink[]>> {
  const { data, error } = await db.rpc("document_file_links", { p_document_id: documentId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      linkId: r.link_id,
      provider: provider(r.provider_code),
      mode: r.link_mode === "Import" ? "Import" : "Link",
      fileName: r.file_name,
      mimeType: typeof r.mime_type === "string" ? r.mime_type : null,
      sizeBytes: typeof r.size_bytes === "number" ? r.size_bytes : null,
      webUrl: typeof r.web_url === "string" ? r.web_url : null,
      modifiedAt: typeof r.external_modified_at === "string" ? r.external_modified_at : null,
      linkedAt: r.created_at,
    })),
  );
}

/** app.storage_connections_for_linking: the Drive and OneDrive connections a document writer may link from. */
export async function listLinkableConnections(
  db: XosClient,
  orgId: string,
): Promise<Result<LinkableConnection[]>> {
  const { data, error } = await db.rpc("storage_connections_for_linking", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      connectionId: r.connection_id,
      provider: r.provider_code === "onedrive_sharepoint" ? "onedrive_sharepoint" : "google_drive",
      displayName: r.display_name,
      accountName: typeof r.external_account_name === "string" ? r.external_account_name : null,
    })),
  );
}

/** Removes a link (a soft delete); row level security lets only a writer of the document do it. */
export async function removeFileLink(db: XosClient, linkId: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("integration_file_links")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", linkId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length > 0 ? ok(null) : fail({ kind: "not-found" });
}
