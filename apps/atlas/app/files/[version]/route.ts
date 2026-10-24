import { fetchTicketFile, recordFileDownload } from "@xos/data/share-links";
import { getMessages, isLocale } from "@xos/i18n";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { copyForViewer, fileResponse } from "@/lib/files/deliver";
import { getViewer } from "@/lib/shell/context";

/**
 * Downloads a Confidential or Restricted file from inside Atlas (Section 8.6, finding A65-016). The
 * download is logged in app.file_access_log and held to the export capability (and step-up for
 * Restricted) by app.record_file_download and by the attachments storage policy itself. A PDF goes
 * out with the viewer's email and the time on every page, and a PNG or JPEG as a PDF carrying them
 * (A103); a file that cannot carry them is refused, never sent unmarked. The viewer cannot read such
 * a file from Storage (1691): the download comes with a ticket, which the file-download Edge Function
 * honors only for this shell, holding the handover secret. Anyone who cannot see the file gets 404
 * (ADR 0003); a member who sees it without the capability is told why.
 */
export async function GET(
  _request: Request,
  { params }: RouteContext<"/files/[version]">,
): Promise<Response> {
  const parsed = z.uuid().safeParse((await params).version);
  const viewer = await getViewer();
  if (!parsed.success || !viewer?.person) return new Response(null, { status: 404 });
  const db = viewer.db;

  const { data: version } = await db
    .from("attachment_versions")
    .select("id, org_id, object_name, filename, content_type, scan_status")
    .eq("id", parsed.data)
    .is("deleted_at", null)
    .maybeSingle();
  if (!version || version.scan_status !== "Clean") return new Response(null, { status: 404 });

  const negotiated = await getLocale();
  const locale = isLocale(negotiated) ? negotiated : "en-US";
  const refuse = (rule: string) => {
    const copy = getMessages(locale).compliance.download as Record<string, string>;
    return new Response(copy[rule] ?? copy["notFound"], {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  };
  const logged = await recordFileDownload(db, version.id);
  if (!logged.ok) {
    if (logged.error.kind !== "refusal") return new Response(null, { status: 404 });
    return refuse(logged.error.rule);
  }

  const config = env();
  let bytes: Uint8Array;
  let watermark = logged.data.watermark;
  if (logged.data.ticket !== null) {
    if (config.XOS_FILE_HANDOVER_SECRET === undefined) {
      console.error("file handover is not set up: XOS_FILE_HANDOVER_SECRET is unset");
      return refuse("download_watermark_unavailable");
    }
    const file = await fetchTicketFile(`${config.SUPABASE_URL}/functions/v1`, logged.data.ticket, {
      handoverSecret: config.XOS_FILE_HANDOVER_SECRET,
    });
    if (!file.ok) {
      console.error("file handover failed", version.id, file.error);
      return refuse("download_watermark_unavailable");
    }
    bytes = file.data.bytes;
    watermark ||= file.data.watermark;
  } else {
    const stored = await db.storage.from("attachments").download(version.object_name);
    if (stored.error || !stored.data) return new Response(null, { status: 404 });
    bytes = new Uint8Array(await stored.data.arrayBuffer());
  }
  const { data: org } = await db
    .from("organizations")
    .select("name")
    .eq("id", version.org_id)
    .maybeSingle();
  const copy = await copyForViewer({
    bytes,
    filename: version.filename,
    contentType: version.content_type,
    watermark,
    viewerEmail: logged.data.viewerEmail ?? viewer.email,
    orgName: org?.name ?? "",
    locale,
    sourceUrl: new URL(`/files/${version.id}`, config.ATLAS_SITE_URL).toString(),
  });
  if (!copy.ok) {
    if (copy.reason !== "unsupported") {
      console.error("watermark failed", version.id, copy.reason, copy.detail ?? "");
    }
    return refuse("download_watermark_unsupported");
  }
  return fileResponse(copy.file);
}
