import { generateExternalDocument } from "@xos/data/documents/generate";
import { isPaper } from "@xos/data/documents/model";
import { isExternalDocumentKind } from "@xos/data/documents/sources-external";
import { getMessages, isLocale } from "@xos/i18n";
import { getLocale } from "next-intl/server";
import { gatewayRecordPath } from "@/lib/documents/links";
import { env } from "@/lib/env";
import { getGatewayContext } from "@/lib/shell/context";

/**
 * A generated document for an external party as tagged PDF/UA-1 (Section 11.9, ADR 0031). The record
 * is read through the api_external views with the caller's session, so a record the caller's
 * engagement or account cannot see answers 404 (ADR 0003). `?paper=a4` prints on A4.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/documents/[kind]/[id]">,
): Promise<Response> {
  const { kind, id } = await params;
  if (!isExternalDocumentKind(kind)) return new Response(null, { status: 404 });
  const ctx = await getGatewayContext();
  if (!ctx) return new Response(null, { status: 404 });
  const query = new URL(request.url).searchParams;
  const paperParam = query.get("paper") ?? "letter";
  const paper = isPaper(paperParam) ? paperParam : "letter";
  const engagementKey = query.get("engagement");
  const negotiated = await getLocale();
  const locale = isLocale(negotiated) ? negotiated : "en-US";
  const result = await generateExternalDocument({
    db: ctx.db,
    kind,
    id,
    locale,
    messages: getMessages(locale).documents,
    paper,
    recordUrl: () =>
      new URL(gatewayRecordPath(kind, engagementKey), env().GATEWAY_SITE_URL).toString(),
  });
  if (!result.ok) {
    if (result.error.kind === "not-found") return new Response(null, { status: 404 });
    console.error("document generation failed", kind, result.error);
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
