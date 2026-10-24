import {
  renderSharedImagePdf,
  watermarkText,
  watermarkedFileName,
} from "@xos/data/documents/generate";
import { stampPdfWatermark, type PdfWatermarkRefusal } from "@xos/data/documents/pdf-watermark";
import { getMessages, type Locale } from "@xos/i18n";

/**
 * Delivering files (Section 8.6, finding A65-016; A103). A Confidential or Restricted PDF or image
 * never leaves unmarked: an uploaded PDF keeps its pages and gets the viewer's email and the time
 * stamped on every one (pdf-watermark.ts), and a PNG or JPEG is rendered through the ADR 0031
 * pipeline into a tagged PDF carrying the same line. A file that cannot carry the mark (another image
 * type, or an encrypted or unreadable PDF) is refused rather than sent as stored. Every other file
 * goes out as stored. Server only.
 */

/** How the watermark is applied to a type (private.watermarkable_content_type, migrations 1380 and 1690). */
export function watermarkKind(contentType: string): "pdf" | "image" | null {
  const type = contentType.trim().toLowerCase();
  if (type === "application/pdf") return "pdf";
  return type === "image/png" || type === "image/jpeg" ? "image" : null;
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

/** Why a copy that must carry the watermark cannot: the type cannot carry it, or the PDF cannot be rewritten. */
export type WatermarkRefusal = "unsupported" | PdfWatermarkRefusal;

export type ViewerCopy =
  | { readonly ok: true; readonly file: DeliveredFile }
  | { readonly ok: false; readonly reason: WatermarkRefusal };

/**
 * The copy a viewer receives: the stored bytes, or, when the copy must carry the watermark, a PDF
 * that shows who received it and when. A copy that must carry it and cannot is refused.
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
}): Promise<ViewerCopy> {
  if (!input.watermark) {
    return {
      ok: true,
      file: { bytes: input.bytes, filename: input.filename, contentType: input.contentType },
    };
  }
  const kind = watermarkKind(input.contentType);
  if (kind === null) return { ok: false, reason: "unsupported" };
  const messages = getMessages(input.locale).documents;
  const now = input.now ?? new Date();
  const watermark = watermarkText(messages, input.locale, input.viewerEmail ?? "unknown", now);
  if (kind === "pdf") {
    const stamped = await stampPdfWatermark(input.bytes, watermark);
    if (!stamped.ok) return { ok: false, reason: stamped.reason };
    return {
      ok: true,
      file: {
        bytes: stamped.bytes,
        filename: watermarkedFileName(input.filename),
        contentType: "application/pdf",
      },
    };
  }
  const pdf = await renderSharedImagePdf({
    bytes: input.bytes,
    filename: input.filename,
    orgName: input.orgName,
    locale: input.locale,
    messages,
    sourceUrl: input.sourceUrl,
    watermark,
    now,
  });
  return {
    ok: true,
    file: { bytes: pdf.bytes, filename: pdf.fileName, contentType: "application/pdf" },
  };
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
