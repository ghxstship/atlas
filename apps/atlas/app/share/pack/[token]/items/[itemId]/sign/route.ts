import { PACK_LINK_TOKEN, parsePackGrants, signPackItem } from "@xos/data/stakeholder-packs";
import { PUBLIC_HEADERS, publicDb, visitorAddress } from "@/lib/live-links/public";
import { observability } from "@/lib/observability";
import { packGrantsFromHeader } from "@/lib/stakeholder-packs/public";

/**
 * Acknowledges a stakeholder pack item with a typed name (B2, ADR 0141): a POST. A refusal returns by a code in the
 * query, never the typed name. It is a receipt, not an e-signature of a contract.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: RouteContext<"/share/pack/[token]/items/[itemId]/sign">,
): Promise<Response> {
  const { token, itemId } = await params;
  if (!PACK_LINK_TOKEN.test(token) || !/^[0-9a-f-]{36}$/.test(itemId)) {
    return new Response(null, { status: 404, headers: PUBLIC_HEADERS });
  }
  const form = await request.formData();
  const signed = await signPackItem(publicDb(), {
    token,
    grants: parsePackGrants(packGrantsFromHeader(request.headers.get("cookie"))),
    itemId,
    signerName: String(form.get("signerName") ?? ""),
    clientAddress: visitorAddress(request.headers),
  });
  if (!signed.ok) {
    observability.logger.error("stakeholder pack acknowledgement failed", {
      route: "/share/pack/[token]/items/[itemId]/sign",
      error: signed.error,
    });
    return new Response(null, { status: 500, headers: PUBLIC_HEADERS });
  }
  const reason = signed.data.refused ? signed.data.reason : null;
  return new Response(null, {
    status: 303,
    headers: {
      ...PUBLIC_HEADERS,
      Location: `/share/pack/${token}${reason ? `?reason=${encodeURIComponent(reason)}` : ""}`,
    },
  });
}
