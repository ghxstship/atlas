/**
 * Previewing files in Atlas (Section 11.4, A142). A preview reads the same bytes a download does,
 * from /files/{version} (app/files/[version]/route.ts): the access log, the export capabilities,
 * step-up and the watermark all apply, so a Confidential or Restricted PDF or image previews as the
 * marked PDF its viewer would download. PDFs render with pdf.js in the browser; images and video play
 * from the received bytes. Office files have no preview, since server conversion is excluded: the
 * previewer offers the download instead. Shared by server and client code.
 */

/** What the previewer does with a file. */
export type PreviewKind = "pdf" | "image" | "video" | "office" | "none";

const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const VIDEOS = new Set(["video/mp4", "video/webm", "video/ogg", "video/quicktime"]);
const OFFICE = [
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.",
  "application/vnd.oasis.opendocument.",
  "application/rtf",
];

/** The kind of preview for a content type, as stored or as delivered. */
export function previewKind(contentType: string | null | undefined): PreviewKind {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "application/pdf") return "pdf";
  if (IMAGES.has(type)) return "image";
  if (VIDEOS.has(type)) return "video";
  if (OFFICE.some((o) => (o.endsWith(".") ? type.startsWith(o) : type === o))) return "office";
  return "none";
}

/** Whether a file row offers Preview: anything the previewer renders or explains. */
export function canPreview(contentType: string | null | undefined): boolean {
  return previewKind(contentType) !== "none";
}

/**
 * Files over this size are not previewed: the browser holds the whole file to draw it. The previewer
 * offers the download instead.
 */
export const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

/** The delivery route a version previews and downloads from. */
export function filePreviewSrc(versionId: string): string {
  return `/files/${encodeURIComponent(versionId)}`;
}

/** The file name a delivered copy carries (RFC 6266), so a watermarked copy keeps its own name. */
export function dispositionFilename(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
    }
  }
  const plain = /filename="([^"]*)"/i.exec(header);
  return plain?.[1] || fallback;
}

/** The zoom steps of the previewer, as fractions of the file's own size. */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

/** The next zoom step in a direction, held at the ends. */
export function nextZoom(current: number, direction: 1 | -1): number {
  const index = ZOOM_STEPS.findIndex((z) => z >= current);
  const at = index === -1 ? ZOOM_STEPS.length - 1 : index;
  const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, at + direction));
  return ZOOM_STEPS[next] ?? 1;
}
