import { recordFileDownload } from "@xos/data/share-links";
import { getMessages, isLocale } from "@xos/i18n";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { copyForViewer, fileResponse } from "@/lib/files/deliver";
import { getViewer } from "@/lib/shell/context";

/**
 * Downloads a Confidential or Restricted file from inside Atlas (Section 8.6, finding A65-016). The
 * download is logged in app.file_access_log and held to the export capability (and step-up for
 * Restricted) by app.record_file_download and by the attachments storage policy itself. A PNG or
 * JPEG goes out as a PDF carrying the viewer's email and the time. Anyone who cannot see the file
 * gets 404 (ADR 0003); a member who sees it without the capability is told why.
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
  const logged = await recordFileDownload(db, version.id);
  if (!logged.ok) {
    if (logged.error.kind !== "refusal") return new Response(null, { status: 404 });
    const copy = getMessages(locale).compliance.download as Record<string, string>;
    return new Response(copy[logged.error.rule] ?? copy["notFound"], {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const stored = await db.storage.from("attachments").download(version.object_name);
  if (stored.error || !stored.data) return new Response(null, { status: 404 });
  const { data: org } = await db
    .from("organizations")
    .select("name")
    .eq("id", version.org_id)
    .maybeSingle();
  const copy = await copyForViewer({
    bytes: new Uint8Array(await stored.data.arrayBuffer()),
    filename: version.filename,
    contentType: version.content_type,
    watermark: logged.data.watermark,
    viewerEmail: logged.data.viewerEmail ?? viewer.email,
    orgName: org?.name ?? "",
    locale,
    sourceUrl: new URL(`/files/${version.id}`, env().ATLAS_SITE_URL).toString(),
  });
  return fileResponse(copy);
}
