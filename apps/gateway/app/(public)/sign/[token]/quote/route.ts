import { generateTokenQuoteDocument } from "@xos/data/documents/generate";
import { isPaper } from "@xos/data/documents/model";
import { previewTokenQuote } from "@xos/data/gateway";
import { isLocale } from "@xos/i18n";
import { loadMessages } from "@xos/i18n/load";
import { PARAM_TYPES } from "@xos/ia";
import { getLocale } from "next-intl/server";
import { TOKEN_DOCUMENT_RECORD_PATH } from "@/lib/documents/links";
import { env } from "@/lib/env";
import { observability } from "@/lib/observability";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * A quote's PDF for a signing link (S4.4-12, ADR 0152). POST only, so the access code travels in the
 * form body and never in a URL. api_public.token_quote re-resolves the link and code, so a wrong code
 * counts toward the lock, and the PDF is built only from what that reader returns. A signing link may
 * be opened from an email, so it refuses anything but a same-origin form post.
 */
export async function POST(
  request: Request,
  { params }: RouteContext<"/sign/[token]/quote">,
): Promise<Response> {
  const { token } = await params;
  if (!PARAM_TYPES.token.test(token)) return new Response(null, { status: 404 });
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return new Response(null, { status: 403 });
  const form = await request.formData();
  const accessCode = String(form.get("accessCode") ?? "").trim();
  const paperValue = String(form.get("paper") ?? "letter");
  const paper = isPaper(paperValue) ? paperValue : "letter";
  const db = await createServerSupabase();
  const read = await previewTokenQuote(db, { token, accessCode });
  if (!read.ok || read.data.refused) return new Response(null, { status: 404 });
  const negotiated = await getLocale();
  const locale = isLocale(negotiated) ? negotiated : "en-US";
  const result = await generateTokenQuoteDocument({
    db,
    quote: read.data.quote,
    locale,
    messages: (await loadMessages(locale)).documents,
    paper,
    recordUrl: () => new URL(TOKEN_DOCUMENT_RECORD_PATH, env().GATEWAY_SITE_URL).toString(),
  });
  if (!result.ok) {
    observability.logger.error("quote document generation failed", { error: result.error });
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
