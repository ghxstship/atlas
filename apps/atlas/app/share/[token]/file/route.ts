import { fetchTicketFile, openShareLink, SHARE_TOKEN } from "@xos/data/share-links";
import { isLocale } from "@xos/i18n";
import { getLocale } from "next-intl/server";
import { env } from "@/lib/env";
import { copyForViewer, fileResponse } from "@/lib/files/deliver";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Opens a share link and sends its file (Section 8.6, finding A65-016; migration 1380). The page's
 * form POSTs the access code here: api_public.open_share_link checks the link (locked after 5 wrong
 * codes, failures counted per address) and answers a single-use ticket, which the file-download Edge
 * Function trades for the bytes. A Confidential PDF goes out with the recipient's email and the time
 * on every page, and a PNG or JPEG as a PDF carrying them (A103); a file that cannot carry them is
 * refused, never sent unmarked. The function hands such a file only to this shell, which sends the
 * handover secret (1691), so a recipient who calls it directly gets nothing. Anything else goes out
 * as stored. A refusal returns to the page with its reason.
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
    console.error("share link open failed", opened.error);
    return new Response(null, { status: 500 });
  }
  if (opened.data.refused) return back(opened.data.reason);

  const config = env();
  if (opened.data.watermark && config.XOS_FILE_HANDOVER_SECRET === undefined) {
    console.error("file handover is not set up: XOS_FILE_HANDOVER_SECRET is unset");
    return back("share_link_unavailable");
  }
  const file = await fetchTicketFile(`${config.SUPABASE_URL}/functions/v1`, opened.data.ticket, {
    handoverSecret: config.XOS_FILE_HANDOVER_SECRET,
  });
  if (!file.ok) {
    if (opened.data.watermark) {
      console.error("share link file handover failed", file.error);
      return back("share_link_unavailable");
    }
    if (file.error.kind !== "not-found") console.error("share link file failed", file.error);
    return back("share_link_invalid");
  }
  const negotiated = await getLocale();
  const copy = await copyForViewer({
    bytes: file.data.bytes,
    filename: opened.data.filename,
    contentType: opened.data.contentType,
    watermark: opened.data.watermark || file.data.watermark,
    viewerEmail: opened.data.recipientEmail,
    orgName: opened.data.orgName,
    locale: isLocale(negotiated) ? negotiated : "en-US",
    sourceUrl: new URL(`/share/${token}`, config.ATLAS_SITE_URL).toString(),
  });
  if (!copy.ok) {
    if (copy.reason !== "unsupported") {
      console.error("share link watermark failed", copy.reason, copy.detail ?? "");
    }
    return back("share_link_watermark_unsupported");
  }
  return fileResponse(copy.file);
}
