import { fetchTicketFile, openShareLink, SHARE_TOKEN } from "@xos/data/share-links";
import { isLocale } from "@xos/i18n";
import { getLocale } from "next-intl/server";
import { env } from "@/lib/env";
import { copyForViewer, fileResponse } from "@/lib/files/deliver";
import { observability } from "@/lib/observability";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Opens a share link and sends its file (Section 8.6, finding A65-016; migration 1380). The page's
 * form POSTs the access code here: api_public.open_share_link checks the link (locked after 5 wrong
 * codes, failures counted per address) and answers a single-use ticket, which the file-download Edge
 * Function trades for the bytes. A Confidential image goes out as a PDF carrying the recipient's email
 * and the time; anything else goes out as stored. A refusal returns to the page with its reason.
 * Failures go to the redacting logger, never the console, so neither the token nor the ticket reaches
 * a log (A69-012).
 */
export async function POST(
  request: Request,
  { params }: RouteContext<"/share/[token]/file">,
): Promise<Response> {
  const { token } = await params;
  if (!SHARE_TOKEN.test(token)) return new Response(null, { status: 404 });
  const back = (reason: string) =>
    new Response(null, {
      status: 303,
      headers: {
        Location: `/share/${token}?reason=${encodeURIComponent(reason)}`,
        "Referrer-Policy": "no-referrer",
      },
    });

  const form = await request.formData();
  const code = String(form.get("accessCode") ?? "").trim();
  const opened = await openShareLink(await createServerSupabase(), {
    token,
    accessCode: code === "" ? null : code,
  });
  if (!opened.ok) {
    observability.logger.error("share link open failed", {
      route: "/share/[token]/file",
      error: opened.error,
    });
    return new Response(null, { status: 500 });
  }
  if (opened.data.refused) return back(opened.data.reason);

  const config = env();
  const file = await fetchTicketFile(`${config.SUPABASE_URL}/functions/v1`, opened.data.ticket);
  if (!file.ok) {
    if (file.error.kind !== "not-found") {
      observability.logger.error("share link file failed", {
        route: "/share/[token]/file",
        error: file.error,
      });
    }
    return back("share_link_invalid");
  }
  const negotiated = await getLocale();
  const copy = await copyForViewer({
    bytes: file.data.bytes,
    filename: opened.data.filename,
    contentType: opened.data.contentType,
    watermark: opened.data.watermark,
    viewerEmail: opened.data.recipientEmail,
    orgName: opened.data.orgName,
    locale: isLocale(negotiated) ? negotiated : "en-US",
    sourceUrl: new URL(`/share/${token}`, config.ATLAS_SITE_URL).toString(),
  });
  return fileResponse(copy);
}
