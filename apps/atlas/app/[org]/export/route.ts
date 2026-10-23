import { requireSecondFactor } from "@xos/data/auth-assurance";
import { buildOrgExport, canExportOrg, recordOrgExport } from "@xos/data/lifecycle";
import { preferReplica } from "@xos/data/read-replica";
import { getOrgContext } from "@/lib/shell/context";
import { replicaClientFor } from "@/lib/supabase/replica";
import { orgToday } from "@/lib/shell/time-zone";

/**
 * The full org export (A36, Section 14.7 and 14.8): one ZIP archive with JSON and CSV of every tenant
 * table, the org's stored files and manifest.json, built with the Owner's own row level security and
 * logged in app.org_exports. Anyone else gets 404 (ADR 0003).
 *
 * It carries the Restricted data the Owner can read, so it needs step-up like every Restricted export (Section 9,
 * Section 8.6, A77): a session that passed a second factor (aal2). Without it the request returns to Danger zone,
 * whose download link asks for the second factor first.
 *
 * With a read replica configured (XOS_READ_REPLICA_URL, Section 5.1) the tables are read there and the files
 * from the primary, which alone serves Storage. A replica that fails, or that leaves a table unreadable, hands
 * the whole export to the primary, so the archive never misses data a replica could not give.
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
  // A Restricted export: the one step-up check, an aal2 session (migration 1333, recency not asked).
  const stepUp = await requireSecondFactor(ctx.viewer.db, { recent: false });
  if (!stepUp.ok) {
    return Response.redirect(new URL(`/${ctx.org.slug}/settings/danger-zone`, request.url), 303);
  }
  const target = { id: ctx.org.id, slug: ctx.org.slug };
  const built = await preferReplica(
    ctx.viewer.db,
    await replicaClientFor(ctx.viewer.db),
    (db) => buildOrgExport(db, target, new Date(), ctx.viewer.db),
    {
      label: "org export",
      usable: (r) => r.ok && r.data.manifest.unreadableTables.length === 0,
      onFallback: (label, reason) => console.warn(`${label} read from the primary`, reason),
    },
  );
  if (!built.ok) {
    console.error("org export failed", built.error);
    return new Response(null, { status: 500 });
  }
  const logged = await recordOrgExport(ctx.viewer.db, ctx.org.id, built.data);
  if (!logged.ok) {
    console.error("org export could not be logged", logged.error);
    return new Response(null, { status: 500 });
  }
  // The archive is named for the org's date, not the UTC date.
  const day = await orgToday(ctx);
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
