import { generateDocument, watermarkText } from "@xos/data/documents/generate";
import type { LoadOptions } from "@xos/data/documents/sources";
import {
  DOCUMENT_CLASSIFICATION,
  isDocumentKind,
  isPrintSizeFor,
  needsWatermark,
} from "@xos/data/documents/model";
import { isLocale } from "@xos/i18n";
import { loadMessages } from "@xos/i18n/load";
import { getLocale } from "next-intl/server";
import { daySheetAudience } from "@/lib/documents/day-sheet-audience";
import { atlasRecordPath } from "@/lib/documents/links";
import { wrapUpLoadOptions } from "@/lib/documents/wrap-up";
import { env } from "@/lib/env";
import { getOrgContext } from "@/lib/shell/context";
import { observability } from "@/lib/observability";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A generated document as tagged PDF/UA-1 (Section 11.9, ADR 0031): the record is read with the
 * viewer's own row level security and must belong to this org, so anyone who cannot open the record
 * gets 404 (ADR 0003). `?paper=a4` prints on A4, and the credential badge also on `a6` and `cr80` cards (P5); any
 * other size prints on US Letter. Rendered on the server only.
 * A Confidential or Restricted document carries the viewer's email and the time (Section 8.6).
 * A day sheet prints for one audience (B7, ADR 0146 decision 3): `?team=<uuid>` or `?department=<code>`, and
 * `&dept=<slug>` keeps only the cues with that show department's call; such a copy always renders version 2.
 * Both a team and a department, or a malformed value, answer 400; a team of another org answers 404. Other kinds
 * ignore these parameters. The wrap-up report's sections follow the reader's capabilities (lib/documents/wrap-up).
 */

export async function GET(
  request: Request,
  { params }: RouteContext<"/[org]/documents/[kind]/[id]">,
): Promise<Response> {
  const { org, kind, id } = await params;
  if (!isDocumentKind(kind)) return new Response(null, { status: 404 });
  const ctx = await getOrgContext(org);
  if (!ctx) return new Response(null, { status: 404 });
  const search = new URL(request.url).searchParams;
  const audience = kind === "day-sheet" ? daySheetAudience(search) : null;
  if (audience === "bad") return new Response(null, { status: 400 });
  const paperParam = search.get("paper") ?? "letter";
  const paper = isPrintSizeFor(kind, paperParam) ? paperParam : "letter";
  const negotiated = await getLocale();
  const locale = isLocale(negotiated) ? negotiated : "en-US";
  const site = env().ATLAS_SITE_URL;
  const messages = (await loadMessages(locale)).documents;
  const watermark = needsWatermark(DOCUMENT_CLASSIFICATION[kind])
    ? watermarkText(messages, locale, ctx.viewer.email ?? ctx.viewer.userId, new Date())
    : undefined;
  const load: LoadOptions =
    kind === "wrap-up-report"
      ? await wrapUpLoadOptions(ctx, ctx.viewer.db, locale, UUID.test(id) ? id : null)
      : audience
        ? { audience }
        : {};
  const result = await generateDocument({
    db: ctx.viewer.db,
    orgId: ctx.org.id,
    orgName: ctx.org.name,
    kind,
    id,
    locale,
    messages,
    paper,
    ...(watermark ? { watermark } : {}),
    load,
    recordUrl: (record) =>
      new URL(atlasRecordPath(ctx.org.slug, kind, { id, ...record }), site).toString(),
  });
  if (!result.ok) {
    if (result.error.kind === "not-found") return new Response(null, { status: 404 });
    // Two audiences or an unknown department (app.day_sheet_schedule).
    if (result.error.kind === "refusal" && result.error.rule === "day_sheet_audience") {
      return new Response(null, { status: 400 });
    }
    observability.logger.error("document generation failed", { kind, error: result.error });
    return new Response(null, { status: 500 });
  }
  return new Response(result.data.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${result.data.fileName}"`,
      "Cache-Control": "private, no-store",
      "X-Document-Template-Version": String(result.data.templateVersion),
    },
  });
}
