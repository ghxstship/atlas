import { z } from "zod";
import { fileResponse } from "@/lib/files/deliver";
import { getViewer } from "@/lib/shell/context";

/**
 * Serves a file a party uploaded to party-uploads (R9, migration 2712): an advance answer's file or
 * a sponsor-supplied brand asset. app.party_file_object answers only for a caller who may read it
 * (the uploading side, or org members with advancing.packet.read or vendors.vendor.read on the
 * project); the download then runs under the caller's session, so the storage policy and the scan
 * read gate apply and nothing that has not scanned Clean leaves storage. Everything else is 404.
 */
export async function GET(
  _request: Request,
  { params }: RouteContext<"/files/party/[version]">,
): Promise<Response> {
  const parsed = z.uuid().safeParse((await params).version);
  const viewer = await getViewer();
  if (!parsed.success || !viewer?.person) return new Response(null, { status: 404 });
  const db = viewer.db;
  const { data, error } = await db.rpc("party_file_object", { p_document_version_id: parsed.data });
  const object = Array.isArray(data) ? data[0] : null;
  if (error || !object?.object_name) return new Response(null, { status: 404 });
  const stored = await db.storage.from("party-uploads").download(object.object_name);
  if (stored.error || !stored.data) return new Response(null, { status: 404 });
  return fileResponse({
    bytes: new Uint8Array(await stored.data.arrayBuffer()),
    filename: object.title ?? object.object_name.split("/").pop() ?? "file",
    contentType: object.content_type ?? "application/octet-stream",
  });
}
