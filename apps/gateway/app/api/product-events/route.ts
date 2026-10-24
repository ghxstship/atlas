/**
 * POST /api/product-events: consent-gated product analytics from the browser (Section 11.14, A96, ADR 0052).
 * Same-origin only and 16 KB at most. Nothing is recorded unless the consent seam allows it (a yes to performance
 * cookies, no Global Privacy Control); otherwise the batch is dropped unread. Events carry route templates and
 * workflow steps only, and are stored with no person. Always answers 204 once the request is well formed.
 */
import { cleanProductEvents, isSessionKey, recordProductEvents } from "@xos/data/product-analytics";
import { env } from "@/lib/env";
import { productAnalyticsConsent } from "@/lib/privacy/product-analytics";
import { isCrossSiteMutation } from "@/lib/security/headers";
import { getGatewayContext } from "@/lib/shell/context";

export const dynamic = "force-dynamic";

const MAX_BYTES = 16 * 1024;

export async function POST(request: Request): Promise<Response> {
  if (
    isCrossSiteMutation({
      method: "POST",
      origin: request.headers.get("origin"),
      host: request.headers.get("host"),
      siteOrigin: env().GATEWAY_SITE_URL,
    })
  ) {
    return new Response(null, { status: 403 });
  }
  if (!(await productAnalyticsConsent())) return new Response(null, { status: 204 });
  const text = await request.text();
  if (text.length > MAX_BYTES) return new Response(null, { status: 413 });
  let body: { sessionKey?: unknown; events?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return new Response(null, { status: 400 });
  }
  const events = cleanProductEvents(body.events);
  if (!isSessionKey(body.sessionKey) || events.length === 0)
    return new Response(null, { status: 204 });
  const ctx = await getGatewayContext();
  if (ctx)
    await recordProductEvents(ctx.db, { app: "Gateway", sessionKey: body.sessionKey, events });
  return new Response(null, { status: 204 });
}
