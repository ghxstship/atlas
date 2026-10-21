import { downloadDeletionCertificate } from "@xos/data/org-lifecycle";
import { deletionCertificateFileName } from "@xos/data/documents/deletion-certificate";
import { getOrgContext } from "@/lib/shell/context";

/**
 * A deletion certificate PDF (A79, Section 14.7) for the former Owner it was issued to: read with their own
 * client, so row level security on app.deletion_certificates and the deletion-certificates bucket decide.
 * The org in the path is any org the person still belongs to; the deleted org is gone. Anyone else gets 404
 * (ADR 0003).
 */
export async function GET(
  _request: Request,
  { params }: RouteContext<"/[org]/deletion-certificates/[id]">,
): Promise<Response> {
  const { org, id } = await params;
  const ctx = await getOrgContext(org);
  if (!ctx || !/^[0-9a-f-]{36}$/.test(id)) return new Response(null, { status: 404 });
  const found = await downloadDeletionCertificate(ctx.viewer.db, id);
  if (!found.ok) return new Response(null, { status: 404 });
  return new Response(found.data.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${deletionCertificateFileName(found.data.certificate)}"`,
      "Cache-Control": "no-store",
      ...(found.data.certificate.documentSha256
        ? { "X-Document-Sha256": found.data.certificate.documentSha256 }
        : {}),
    },
  });
}
