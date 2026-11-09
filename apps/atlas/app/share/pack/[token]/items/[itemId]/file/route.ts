import { fetchTicketFile } from "@xos/data/share-links";
import { PACK_LINK_TOKEN, packFileTicket, parsePackGrants } from "@xos/data/stakeholder-packs";
import { env } from "@/lib/env";
import { PUBLIC_HEADERS, publicDb, visitorAddress } from "@/lib/live-links/public";
import { observability } from "@/lib/observability";
import { packGrantsFromHeader } from "@/lib/stakeholder-packs/public";

/**
 * Downloads a stakeholder pack's file item (B2, ADR 0141): a POST, since each one logs. The token RPC answers a
 * 2-minute single-use ticket, which the file-download Edge Function trades for the bytes, as /share/{token}/file
 * does. Pack files are Public or Internal, so none carries a watermark. A refusal returns to the pack with its reason.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: RouteContext<"/share/pack/[token]/items/[itemId]/file">,
): Promise<Response> {
  const { token, itemId } = await params;
  if (!PACK_LINK_TOKEN.test(token) || !/^[0-9a-f-]{36}$/.test(itemId)) {
    return new Response(null, { status: 404, headers: PUBLIC_HEADERS });
  }
  const back = (reason: string) =>
    new Response(null, {
      status: 303,
      headers: {
        ...PUBLIC_HEADERS,
        Location: `/share/pack/${token}?reason=${encodeURIComponent(reason)}`,
      },
    });
  const issued = await packFileTicket(publicDb(), {
    token,
    grants: parsePackGrants(packGrantsFromHeader(request.headers.get("cookie"))),
    itemId,
    clientAddress: visitorAddress(request.headers),
  });
  if (!issued.ok) {
    observability.logger.error("stakeholder pack file failed", {
      route: "/share/pack/[token]/items/[itemId]/file",
      error: issued.error,
    });
    return new Response(null, { status: 500, headers: PUBLIC_HEADERS });
  }
  if (issued.data.refused) return back(issued.data.reason);
  const file = await fetchTicketFile(`${env().SUPABASE_URL}/functions/v1`, issued.data.ticket);
  if (!file.ok) {
    observability.logger.error("stakeholder pack file download failed", {
      route: "/share/pack/[token]/items/[itemId]/file",
      error: file.error,
    });
    return back("pack_item_unavailable");
  }
  return new Response(file.data.bytes as BodyInit, {
    status: 200,
    headers: {
      ...PUBLIC_HEADERS,
      "Content-Type": issued.data.contentType || file.data.contentType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(issued.data.filename)}`,
    },
  });
}
