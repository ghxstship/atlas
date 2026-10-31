import { openShowcallerLink, SHOWCALLER_TOKEN, showcallerPath } from "@xos/data/showcaller-links";
import { observability } from "@/lib/observability";
import {
  PUBLIC_HEADERS,
  publicDb,
  showcallerGrantCookie,
  visitorAddress,
} from "@/lib/showcaller/public";

/**
 * Opens a showcaller link with its access code (B3, ADR 0142), as lib/live-links/open-route.ts does for P1. Only a
 * POST opens, with the code in the form body (never the address), because every open counts toward the lockout and
 * the address limit (A69-001); a GET goes back to the portal, which shows the code form. A correct code sets the
 * device grant cookie and returns to the portal; a refusal returns with ?reason=. Failures go to the redacting
 * logger, never with the token, the code or the grant.
 */
export const dynamic = "force-dynamic";

const back = (token: string, reason: string | null, cookie?: string) =>
  new Response(null, {
    status: 303,
    headers: {
      ...PUBLIC_HEADERS,
      Location: `${showcallerPath(token)}${reason ? `?reason=${encodeURIComponent(reason)}` : ""}`,
      ...(cookie ? { "Set-Cookie": cookie } : {}),
    },
  });

export async function GET(
  _request: Request,
  { params }: RouteContext<"/share/showcaller/[token]/open">,
) {
  const { token } = await params;
  if (!SHOWCALLER_TOKEN.test(token))
    return new Response(null, { status: 404, headers: PUBLIC_HEADERS });
  return back(token, null);
}

export async function POST(
  request: Request,
  { params }: RouteContext<"/share/showcaller/[token]/open">,
) {
  const { token } = await params;
  if (!SHOWCALLER_TOKEN.test(token))
    return new Response(null, { status: 404, headers: PUBLIC_HEADERS });
  const form = await request.formData();
  const code = String(form.get("accessCode") ?? "").trim();
  const opened = await openShowcallerLink(publicDb(), {
    token,
    accessCode: code === "" ? null : code,
    clientAddress: visitorAddress(request.headers),
  });
  if (!opened.ok) {
    observability.logger.error("showcaller link open failed", {
      route: "/share/showcaller/[token]/open",
      error: opened.error,
    });
    return new Response(null, { status: 500, headers: PUBLIC_HEADERS });
  }
  if (opened.data.refused) return back(token, opened.data.reason);
  return back(
    token,
    null,
    showcallerGrantCookie(token, opened.data.grant, opened.data.grantExpiresAt),
  );
}
