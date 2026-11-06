import { INTAKE_TOKEN, intakePath, openIntake } from "@xos/data/vendor-intake";
import { observability } from "@/lib/observability";
import {
  INTAKE_GRANT_COOKIE,
  pathGrantCookie,
  PUBLIC_HEADERS,
  publicDb,
  visitorAddress,
} from "@/lib/outside/public";

/**
 * Opens a vendor intake link with its access code (B2, ADR 0141). Only a POST opens, with the code in the form body,
 * because each open counts toward the lockout and the address limit; a GET goes back to the page. A correct code sets
 * the grant cookie on this link's path, for 24 hours or until the link expires.
 */
export const dynamic = "force-dynamic";

const back = (token: string, reason: string | null, cookie?: string) =>
  new Response(null, {
    status: 303,
    headers: {
      ...PUBLIC_HEADERS,
      Location: `${intakePath(token)}${reason ? `?reason=${encodeURIComponent(reason)}` : ""}`,
      ...(cookie ? { "Set-Cookie": cookie } : {}),
    },
  });

export async function GET(_request: Request, { params }: RouteContext<"/onboard/[token]/open">) {
  const { token } = await params;
  if (!INTAKE_TOKEN.test(token))
    return new Response(null, { status: 404, headers: PUBLIC_HEADERS });
  return back(token, null);
}

export async function POST(request: Request, { params }: RouteContext<"/onboard/[token]/open">) {
  const { token } = await params;
  if (!INTAKE_TOKEN.test(token))
    return new Response(null, { status: 404, headers: PUBLIC_HEADERS });
  const form = await request.formData();
  const code = String(form.get("accessCode") ?? "").trim();
  const opened = await openIntake(publicDb(), {
    token,
    accessCode: code === "" ? null : code,
    clientAddress: visitorAddress(request.headers),
  });
  if (!opened.ok) {
    observability.logger.error("vendor intake open failed", {
      route: "/onboard/[token]/open",
      error: opened.error,
    });
    return new Response(null, { status: 500, headers: PUBLIC_HEADERS });
  }
  if (opened.data.refused) return back(token, opened.data.reason);
  return back(
    token,
    null,
    pathGrantCookie(
      INTAKE_GRANT_COOKIE,
      intakePath(token),
      opened.data.grant,
      opened.data.grantExpiresAt,
    ),
  );
}
