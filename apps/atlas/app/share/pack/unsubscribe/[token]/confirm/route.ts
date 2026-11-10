import { PACK_UNSUBSCRIBE_TOKEN, unsubscribeStakeholderPack } from "@xos/data/stakeholder-packs";
import { PUBLIC_HEADERS, publicDb, visitorAddress } from "@/lib/live-links/public";
import { observability } from "@/lib/observability";

/** The confirm button of a pack's stop-email page (B2, ADR 0141): only a POST acts; a GET goes back. */
export const dynamic = "force-dynamic";

const back = (token: string, query: string) =>
  new Response(null, {
    status: 303,
    headers: { ...PUBLIC_HEADERS, Location: `/share/pack/unsubscribe/${token}${query}` },
  });

export async function GET(
  _request: Request,
  { params }: RouteContext<"/share/pack/unsubscribe/[token]/confirm">,
) {
  const { token } = await params;
  if (!PACK_UNSUBSCRIBE_TOKEN.test(token)) {
    return new Response(null, { status: 404, headers: PUBLIC_HEADERS });
  }
  return back(token, "");
}

export async function POST(
  request: Request,
  { params }: RouteContext<"/share/pack/unsubscribe/[token]/confirm">,
) {
  const { token } = await params;
  if (!PACK_UNSUBSCRIBE_TOKEN.test(token)) {
    return new Response(null, { status: 404, headers: PUBLIC_HEADERS });
  }
  const done = await unsubscribeStakeholderPack(publicDb(), {
    token,
    clientAddress: visitorAddress(request.headers),
  });
  if (!done.ok) {
    observability.logger.error("stakeholder pack unsubscribe failed", {
      route: "/share/pack/unsubscribe/[token]/confirm",
      error: done.error,
    });
    return new Response(null, { status: 500, headers: PUBLIC_HEADERS });
  }
  return back(token, done.data.refused ? `?reason=${done.data.reason}` : "?done=1");
}
