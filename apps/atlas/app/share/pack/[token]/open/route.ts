import {
  openStakeholderPack,
  PACK_LINK_TOKEN,
  packPath,
  parsePackGrants,
} from "@xos/data/stakeholder-packs";
import { PUBLIC_HEADERS, publicDb, visitorAddress } from "@/lib/live-links/public";
import { observability } from "@/lib/observability";
import { packGrantCookie, packGrantsFromHeader } from "@/lib/stakeholder-packs/public";

/**
 * Opens a stakeholder pack with the recipient's code or a grant the device holds (B2, ADR 0141). Only a POST
 * opens, with the code in the form body (never the address), because an open counts toward the lockout and
 * the address limit (A69-001); a GET goes back to the page. A success sets the grant cookie and returns to the
 * page; a refusal returns with ?reason=. Failures go to the redacting logger, never with a token, code or grant.
 */
export const dynamic = "force-dynamic";

const back = (token: string, reason: string | null, cookie?: string) =>
  new Response(null, {
    status: 303,
    headers: {
      ...PUBLIC_HEADERS,
      Location: `${packPath(token)}${reason ? `?reason=${encodeURIComponent(reason)}` : cookie ? "?opened=1" : ""}`,
      ...(cookie ? { "Set-Cookie": cookie } : {}),
    },
  });

export async function GET(_request: Request, { params }: RouteContext<"/share/pack/[token]/open">) {
  const { token } = await params;
  if (!PACK_LINK_TOKEN.test(token)) {
    return new Response(null, { status: 404, headers: PUBLIC_HEADERS });
  }
  return back(token, null);
}

export async function POST(request: Request, { params }: RouteContext<"/share/pack/[token]/open">) {
  const { token } = await params;
  if (!PACK_LINK_TOKEN.test(token)) {
    return new Response(null, { status: 404, headers: PUBLIC_HEADERS });
  }
  const form = await request.formData();
  const code = String(form.get("accessCode") ?? "").trim();
  const current = packGrantsFromHeader(request.headers.get("cookie"));
  const opened = await openStakeholderPack(publicDb(), {
    token,
    accessCode: code === "" ? null : code,
    grants: parsePackGrants(current),
    clientAddress: visitorAddress(request.headers),
  });
  if (!opened.ok) {
    observability.logger.error("stakeholder pack open failed", {
      route: "/share/pack/[token]/open",
      error: opened.error,
    });
    return new Response(null, { status: 500, headers: PUBLIC_HEADERS });
  }
  if (opened.data.refused) return back(token, opened.data.reason);
  return back(token, null, packGrantCookie(current, opened.data.grant, opened.data.grantExpiresAt));
}
