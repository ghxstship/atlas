import { generateDocument, watermarkText } from "@xos/data/documents/generate";
import {
  DOCUMENT_CLASSIFICATION,
  isDocumentKind,
  isPaper,
  needsWatermark,
} from "@xos/data/documents/model";
import { isLocale } from "@xos/i18n";
import { loadMessages } from "@xos/i18n/load";
import { getLocale } from "next-intl/server";
import { atlasRecordPath } from "@/lib/documents/links";
import { env } from "@/lib/env";
import { getOrgContext } from "@/lib/shell/context";
import { observability } from "@/lib/observability";

/**
 * A generated document as tagged PDF/UA-1 (Section 11.9, ADR 0031): the record is read with the
 * viewer's own row level security and must belong to this org, so anyone who cannot open the record
 * gets 404 (ADR 0003). `?paper=a4` prints on A4; US Letter otherwise. Rendered on the server only.
 * A Confidential or Restricted document carries the viewer's email and the time (Section 8.6).
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/[org]/documents/[kind]/[id]">,
): Promise<Response> {
  const { org, kind, id } = await params;
  if (!isDocumentKind(kind)) return new Response(null, { status: 404 });
  const ctx = await getOrgContext(org);
  if (!ctx) return new Response(null, { status: 404 });
  const paperParam = new URL(request.url).searchParams.get("paper") ?? "letter";
  const paper = isPaper(paperParam) ? paperParam : "letter";
  const negotiated = await getLocale();
  const locale = isLocale(negotiated) ? negotiated : "en-US";
  const site = env().ATLAS_SITE_URL;
  const messages = (await loadMessages(locale)).documents;
  const watermark = needsWatermark(DOCUMENT_CLASSIFICATION[kind])
    ? watermarkText(messages, locale, ctx.viewer.email ?? ctx.viewer.userId, new Date())
    : undefined;
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
    recordUrl: (record) =>
      new URL(atlasRecordPath(ctx.org.slug, kind, { id, ...record }), site).toString(),
  });
  if (!result.ok) {
    if (result.error.kind === "not-found") return new Response(null, { status: 404 });
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
