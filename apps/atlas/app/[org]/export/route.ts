import { getSecondFactorStatus } from "@xos/data/auth-assurance";
import { buildOrgExport, canExportOrg, recordOrgExport } from "@xos/data/lifecycle";
import { getOrgContext } from "@/lib/shell/context";

/**
 * The full org export (A36, Section 14.7 and 14.8): one ZIP archive with JSON and CSV of every tenant
 * table, the org's stored files and manifest.json, built with the Owner's own row level security and
 * logged in app.org_exports. Anyone else gets 404 (ADR 0003).
 *
 * It carries the Restricted data the Owner can read, so it needs step-up like every Restricted export (Section 9,
 * Section 8.6, A77): a session that passed a second factor (aal2). Without it the request returns to Danger zone,
 * whose download link asks for the second factor first.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/[org]/export">,
): Promise<Response> {
  const { org } = await params;
  const ctx = await getOrgContext(org);
  if (!ctx) return new Response(null, { status: 404 });
  const allowed = await canExportOrg(ctx.viewer.db, ctx.org.id);
  if (!allowed.ok || !allowed.data) return new Response(null, { status: 404 });
  const stepUp = await getSecondFactorStatus(ctx.viewer.db);
  if (!stepUp.ok || !stepUp.data.steppedUp) {
    return Response.redirect(new URL(`/${ctx.org.slug}/settings/danger-zone`, request.url), 303);
  }
  const built = await buildOrgExport(ctx.viewer.db, { id: ctx.org.id, slug: ctx.org.slug });
  if (!built.ok) {
    console.error("org export failed", built.error);
    return new Response(null, { status: 500 });
  }
  const logged = await recordOrgExport(ctx.viewer.db, ctx.org.id, built.data);
  if (!logged.ok) {
    console.error("org export could not be logged", logged.error);
    return new Response(null, { status: 500 });
  }
  const day = new Date().toISOString().slice(0, 10);
  return new Response(built.data.archive as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${ctx.org.slug}-export-${day}.zip"`,
      "Cache-Control": "no-store",
      "X-Export-Manifest-Sha256": built.data.manifestSha256,
    },
  });
}
