import "server-only";

import {
  DISPLAY_TOKEN,
  LIVE_VIEW_TOKEN,
  liveLinkPath,
  openLiveLink,
  type LiveLinkKind,
} from "@xos/data/live-links";
import { observability } from "@/lib/observability";
import { grantCookie, PUBLIC_HEADERS, publicDb, visitorAddress } from "./public";

/**
 * The open handler of a live link (P1, ADR 0130): /share/view/{token}/open and
 * /share/screen/{token}/open. Only a POST opens a link, with the access code in the form body (never
 * the address), because every open counts toward the lockout and the address limit (A69-001); a GET
 * goes back to the page, which shows the code form. A correct code sets the device grant cookie and
 * returns to the page; a refusal returns with ?reason=. Failures go to the redacting logger, never
 * with the token, the code or the grant.
 */
export function liveLinkOpenHandlers(kind: LiveLinkKind) {
  const shape = kind === "View" ? LIVE_VIEW_TOKEN : DISPLAY_TOKEN;
  const route = kind === "View" ? "/share/view/[token]/open" : "/share/screen/[token]/open";
  const back = (token: string, reason: string | null, cookie?: string) =>
    new Response(null, {
      status: 303,
      headers: {
        ...PUBLIC_HEADERS,
        Location: `${liveLinkPath(kind, token)}${reason ? `?reason=${encodeURIComponent(reason)}` : ""}`,
        ...(cookie ? { "Set-Cookie": cookie } : {}),
      },
    });

  async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    if (!shape.test(token)) return new Response(null, { status: 404, headers: PUBLIC_HEADERS });
    return back(token, null);
  }

  async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    if (!shape.test(token)) return new Response(null, { status: 404, headers: PUBLIC_HEADERS });
    const form = await request.formData();
    const code = String(form.get("accessCode") ?? "").trim();
    const opened = await openLiveLink(publicDb(), {
      kind,
      token,
      accessCode: code === "" ? null : code,
      clientAddress: visitorAddress(request.headers),
    });
    if (!opened.ok) {
      observability.logger.error("live link open failed", { route, error: opened.error });
      return new Response(null, { status: 500, headers: PUBLIC_HEADERS });
    }
    if (opened.data.refused) return back(token, opened.data.reason);
    return back(
      token,
      null,
      grantCookie(kind, token, opened.data.grant, opened.data.grantExpiresAt),
    );
  }

  return { GET, POST };
}
