import { generateBadgeBatch } from "@xos/data/documents/generate";
import { isPrintSizeFor } from "@xos/data/documents/model";
import { MAX_BATCH } from "@xos/data/documents/render";
import { isLocale } from "@xos/i18n";
import { loadMessages } from "@xos/i18n/load";
import { getLocale } from "next-intl/server";
import { atlasRecordPath } from "@/lib/documents/links";
import { env } from "@/lib/env";
import { observability } from "@/lib/observability";
import { getOrgContext } from "@/lib/shell/context";

/** A run of 100 badges with photos takes a while to draw; the stream starts with the first one. */
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Credential badges in one PDF (P5, ADR 0031 amendment): `?id=` repeated 1 to 100 times and `&paper=` Letter, A4,
 * A6 or CR80 (the default). Each credential is read with the viewer's own row level security and must belong to
 * this org; those the viewer cannot read, of another org, revoked or expired are left out and counted in
 * X-Badges-Skipped. 400 for no id, more than 100 or a malformed one; 404 when nothing is left to print. The PDF is
 * streamed as each badge is drawn, since a run with photos is larger than a buffered function response allows.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/[org]/documents/badges">,
): Promise<Response> {
  const { org } = await params;
  const ctx = await getOrgContext(org);
  if (!ctx) return new Response(null, { status: 404 });
  const search = new URL(request.url).searchParams;
  const ids = search.getAll("id");
  if (ids.length < 1 || ids.length > MAX_BATCH || !ids.every((id) => UUID.test(id))) {
    return new Response(null, { status: 400 });
  }
  const paperParam = search.get("paper") ?? "cr80";
  const paper = isPrintSizeFor("credential-badge", paperParam) ? paperParam : "cr80";
  const negotiated = await getLocale();
  const locale = isLocale(negotiated) ? negotiated : "en-US";
  const site = env().ATLAS_SITE_URL;
  const result = await generateBadgeBatch({
    db: ctx.viewer.db,
    orgId: ctx.org.id,
    orgName: ctx.org.name,
    ids: ids.map((id) => id.toLowerCase()),
    locale,
    messages: (await loadMessages(locale)).documents,
    paper,
    recordUrl: (record) =>
      new URL(atlasRecordPath(ctx.org.slug, "credential-badge", record), site).toString(),
  });
  if (!result.ok) {
    if (result.error.kind === "not-found") return new Response(null, { status: 404 });
    if (result.error.kind === "invalid") return new Response(null, { status: 400 });
    observability.logger.error("badge batch failed", { error: result.error });
    return new Response(null, { status: 500 });
  }
  return new Response(result.data.stream, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${result.data.fileName}"`,
      "Cache-Control": "private, no-store",
      "X-Badges-Skipped": String(result.data.skipped),
    },
  });
}
