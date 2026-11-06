import { FORM_LINK_TOKEN, formLinkPath, openFormLink } from "@xos/data/form-links";
import { observability } from "@/lib/observability";
import {
  FORM_GRANT_COOKIE,
  pathGrantCookie,
  PUBLIC_HEADERS,
  publicDb,
  visitorAddress,
} from "@/lib/outside/public";

/**
 * Opens a public form link with its access code (B2, ADR 0141). Only a POST opens, with the code in the form body; a
 * GET goes back to the page. A correct code sets the grant cookie on this link's path for 2 hours.
 */
export const dynamic = "force-dynamic";

const back = (token: string, reason: string | null, cookie?: string) =>
  new Response(null, {
    status: 303,
    headers: {
      ...PUBLIC_HEADERS,
      Location: `${formLinkPath(token)}${reason ? `?reason=${encodeURIComponent(reason)}` : ""}`,
      ...(cookie ? { "Set-Cookie": cookie } : {}),
    },
  });

export async function GET(_request: Request, { params }: RouteContext<"/forms/[token]/open">) {
  const { token } = await params;
  if (!FORM_LINK_TOKEN.test(token)) return new Response(null, { status: 404, headers: PUBLIC_HEADERS });
  return back(token, null);
}

export async function POST(request: Request, { params }: RouteContext<"/forms/[token]/open">) {
  const { token } = await params;
  if (!FORM_LINK_TOKEN.test(token)) return new Response(null, { status: 404, headers: PUBLIC_HEADERS });
  const form = await request.formData();
  const code = String(form.get("accessCode") ?? "").trim();
  const opened = await openFormLink(publicDb(), {
    token,
    accessCode: code === "" ? null : code,
    clientAddress: visitorAddress(request.headers),
  });
  if (!opened.ok) {
    observability.logger.error("public form open failed", {
      route: "/forms/[token]/open",
      error: opened.error,
    });
    return new Response(null, { status: 500, headers: PUBLIC_HEADERS });
  }
  if (opened.data.refused) return back(token, opened.data.reason);
  return back(
    token,
    null,
    pathGrantCookie(FORM_GRANT_COOKIE, formLinkPath(token), opened.data.grant, opened.data.grantExpiresAt),
  );
}
