import { renderSharedImagePdf, watermarkText } from "@xos/data/documents/generate";
import { getMessages, type Locale } from "@xos/i18n";

/**
 * Delivering files (Section 8.6, finding A65-016). A Confidential or Restricted PNG or JPEG never
 * leaves unmarked: it is rendered through the ADR 0031 pipeline into a tagged PDF carrying the
 * viewer's email and the time. Every other file goes out as stored. Server only.
 */

/** Image types the watermark can carry (private.watermarkable_content_type in migration 1380). */
export function watermarkableImage(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return type === "image/png" || type === "image/jpeg";
}

/** An RFC 6266 attachment disposition with an ASCII fallback and the UTF-8 file name. */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_") || "file";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface DeliveredFile {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly contentType: string;
}

/**
 * The record link a watermarked copy prints and draws as a QR code (ADR 0031): /files/{version},
 * which opens only for a signed-in member who may see the file. Never a share link, whose token
 * would let anyone holding a forwarded copy open it again (A69-013); without a version it is the
 * Atlas home page.
 */
export function copyRecordUrl(versionId: string | null, siteUrl: string): string {
  return new URL(versionId ? `/files/${encodeURIComponent(versionId)}` : "/", siteUrl).toString();
}

/**
 * The copy a viewer receives: the stored bytes, or for a watermarked image a PDF that shows who
 * received it and when.
 */
export async function copyForViewer(input: {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly contentType: string;
  readonly watermark: boolean;
  readonly viewerEmail: string | null;
  readonly orgName: string;
  readonly locale: Locale;
  readonly sourceUrl: string;
  readonly now?: Date;
}): Promise<DeliveredFile> {
  if (!input.watermark || !watermarkableImage(input.contentType)) {
    return { bytes: input.bytes, filename: input.filename, contentType: input.contentType };
  }
  const messages = getMessages(input.locale).documents;
  const now = input.now ?? new Date();
  const pdf = await renderSharedImagePdf({
    bytes: input.bytes,
    filename: input.filename,
    orgName: input.orgName,
    locale: input.locale,
    messages,
    sourceUrl: input.sourceUrl,
    watermark: watermarkText(messages, input.locale, input.viewerEmail ?? "unknown", now),
    now,
  });
  return { bytes: pdf.bytes, filename: pdf.fileName, contentType: "application/pdf" };
}

/** The download response: attachment, never cached, never sniffed, no referrer. */
export function fileResponse(file: DeliveredFile): Response {
  return new Response(file.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": attachmentDisposition(file.filename),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
