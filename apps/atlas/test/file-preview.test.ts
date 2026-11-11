import { describe, expect, it } from "vitest";
import {
  PREVIEW_MAX_BYTES,
  canPreview,
  dispositionFilename,
  filePreviewSrc,
  nextZoom,
  previewKind,
} from "../lib/files/preview";
import { attachmentDisposition } from "../lib/files/deliver";

describe("file previews (A142)", () => {
  it("previews PDFs, images and video, and explains Office files", () => {
    expect(previewKind("application/pdf")).toBe("pdf");
    expect(previewKind("Image/PNG")).toBe("image");
    expect(previewKind("image/jpeg; charset=binary")).toBe("image");
    expect(previewKind("video/mp4")).toBe("video");
    expect(
      previewKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ).toBe("office");
    expect(previewKind("application/vnd.ms-excel")).toBe("office");
    expect(previewKind("application/vnd.oasis.opendocument.text")).toBe("office");
    expect(canPreview("application/vnd.ms-powerpoint")).toBe(true);
  });

  it("offers nothing for types it neither draws nor explains, SVG and HTML among them", () => {
    for (const type of ["image/svg+xml", "text/html", "application/zip", "", null, undefined]) {
      expect(previewKind(type)).toBe("none");
      expect(canPreview(type)).toBe(false);
    }
  });

  it("reads files through the delivery route that logs and watermarks them", () => {
    expect(filePreviewSrc("4b1c0f0e-8a8d-4f43-9d5e-0c7f1a1f2b3c")).toBe(
      "/files/4b1c0f0e-8a8d-4f43-9d5e-0c7f1a1f2b3c",
    );
    expect(PREVIEW_MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  it("keeps the name a delivered copy carries, such as a watermarked copy's", () => {
    expect(dispositionFilename(attachmentDisposition("rider-watermarked.pdf"), "rider.pdf")).toBe(
      "rider-watermarked.pdf",
    );
    expect(dispositionFilename(attachmentDisposition("plan año.pdf"), "x.pdf")).toBe(
      "plan año.pdf",
    );
    expect(dispositionFilename('attachment; filename="plain.pdf"', "x.pdf")).toBe("plain.pdf");
    expect(dispositionFilename("attachment; filename*=UTF-8''%E0%A4%A", "fallback.pdf")).toBe(
      "fallback.pdf",
    );
    expect(dispositionFilename(null, "fallback.pdf")).toBe("fallback.pdf");
  });

  it("zooms in steps and holds at the ends", () => {
    expect(nextZoom(1, 1)).toBe(1.25);
    expect(nextZoom(1, -1)).toBe(0.75);
    expect(nextZoom(3, 1)).toBe(3);
    expect(nextZoom(0.5, -1)).toBe(0.5);
  });
});
