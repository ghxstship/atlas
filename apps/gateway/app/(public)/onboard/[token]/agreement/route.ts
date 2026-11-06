import { fetchTicketFile } from "@xos/data/share-links";
import { INTAKE_TOKEN, intakeAgreementTicket, intakePath } from "@xos/data/vendor-intake";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { observability } from "@/lib/observability";
import { INTAKE_GRANT_COOKIE, PUBLIC_HEADERS, publicDb, visitorAddress } from "@/lib/outside/public";

/**
 * Downloads an intake link's pinned agreement version (B2, ADR 0141): a POST, since each one logs. A 2-minute ticket
 * is traded at the file-download Edge Function; the file is Public or Internal, so it carries no watermark.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: RouteContext<"/onboard/[token]/agreement">) {
  const { token } = await params;
  if (!INTAKE_TOKEN.test(token)) return new Response(null, { status: 404, headers: PUBLIC_HEADERS });
  const back = (reason: string) =>
    new Response(null, {
      status: 303,
      headers: { ...PUBLIC_HEADERS, Location: `${intakePath(token)}?reason=${encodeURIComponent(reason)}` },
    });
  const issued = await intakeAgreementTicket(publicDb(), {
    token,
    grant: (await cookies()).get(INTAKE_GRANT_COOKIE)?.value ?? "",
    clientAddress: visitorAddress(request.headers),
  });
  if (!issued.ok) {
    observability.logger.error("vendor intake agreement failed", {
      route: "/onboard/[token]/agreement",
      error: issued.error,
    });
    return new Response(null, { status: 500, headers: PUBLIC_HEADERS });
  }
  if (issued.data.refused) return back(issued.data.reason);
  const file = await fetchTicketFile(`${env().SUPABASE_URL}/functions/v1`, issued.data.ticket);
  if (!file.ok) return back("intake_agreement_unavailable");
  return new Response(file.data.bytes as BodyInit, {
    status: 200,
    headers: {
      ...PUBLIC_HEADERS,
      "Content-Type": issued.data.contentType || file.data.contentType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(issued.data.filename)}`,
    },
  });
}
