// @vitest-environment jsdom
/**
 * A142: the file previewer panel and its Preview button, rendered in a browser-like document with the
 * delivery route faked. The panel asks the route for the bytes, so a refusal shows the route's own
 * sentence, an Office file is never fetched and offers the download, an image draws from a blob: URL of
 * what was delivered, a PDF draws its pages, and a Confidential or Restricted file says it previews
 * watermarked.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getMessages } from "@xos/i18n";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pdf = vi.hoisted(() => ({
  draw: vi.fn(async () => undefined),
  close: vi.fn(),
  opened: [] as Uint8Array[],
}));

// pdf.js needs a real canvas; the panel's part is handing it the delivered bytes and a canvas per page.
vi.mock("@/components/files/pdf-render", () => ({
  openPdf: async (bytes: Uint8Array) => {
    pdf.opened.push(bytes);
    return { count: 3, draw: pdf.draw, close: pdf.close };
  },
}));

const { FilePreviewPanel } = await import("@/components/files/file-preview-panel");
const { AttachmentPreview, FilePreviewButton } = await import("@/components/files/file-preview");

const messages = getMessages("en-US");
type IntlProps = ComponentProps<typeof NextIntlClientProvider>;
const intl: Omit<IntlProps, "children"> = { locale: "en-US", timeZone: "UTC", messages };

function show(element: ReactNode) {
  return render(createElement(NextIntlClientProvider, intl as IntlProps, element));
}

const fetchMock = vi.fn<typeof fetch>();
const objectUrls: string[] = [];

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  objectUrls.length = 0;
  pdf.opened.length = 0;
  pdf.draw.mockClear();
  pdf.close.mockClear();
  // jsdom has no object URLs; the panel only needs a stable one per delivered blob.
  URL.createObjectURL = () => {
    const url = `blob:preview-${objectUrls.length + 1}`;
    objectUrls.push(url);
    return url;
  };
  URL.revokeObjectURL = () => undefined;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const delivered = (body: string, type: string, filename?: string) =>
  new Response(body, {
    status: 200,
    headers: {
      "content-type": type,
      ...(filename ? { "content-disposition": `inline; filename="${filename}"` } : {}),
    },
  });

describe("FilePreviewPanel", () => {
  it("asks the delivery route and shows its refusal as sent", async () => {
    fetchMock.mockResolvedValue(
      new Response("Step up your sign-in to open Restricted files.", { status: 403 }),
    );
    show(
      createElement(FilePreviewPanel, {
        src: "/files/v-1",
        name: "Rider.pdf",
        contentType: "application/pdf",
        classification: "Restricted",
        onClose: () => undefined,
      }),
    );
    expect(await screen.findByText("Step up your sign-in to open Restricted files.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/files/v-1");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
    });
    // Nothing was delivered, so there is nothing to download.
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });

  it("never fetches an Office file and offers its download", async () => {
    const open = vi.fn<typeof window.open>(() => null);
    vi.stubGlobal("open", open);
    show(
      createElement(FilePreviewPanel, {
        src: "/files/v-2",
        name: "Budget.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        onClose: () => undefined,
      }),
    );
    expect(
      screen.getByText("Office files can't be previewed here. Download the file to open it."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(open).toHaveBeenCalledWith("/files/v-2", "_blank", "noopener");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch a file over the preview size limit", () => {
    show(
      createElement(FilePreviewPanel, {
        src: "/files/v-3",
        name: "Walkthrough.mp4",
        contentType: "video/mp4",
        sizeBytes: 26 * 1024 * 1024,
        onClose: () => undefined,
      }),
    );
    expect(
      screen.getByText("This file is too large to preview. Download the file to open it."),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("draws an image from a blob: URL of the delivered bytes", async () => {
    fetchMock.mockResolvedValue(delivered("png-bytes", "image/png"));
    show(
      createElement(FilePreviewPanel, {
        src: "/files/v-4",
        name: "Stage plot.png",
        contentType: "image/png",
        classification: "Internal",
        onClose: () => undefined,
      }),
    );
    const image = await screen.findByRole("img", { name: "Stage plot.png" });
    expect(image.getAttribute("src")).toBe("blob:preview-1");
    expect(image.getAttribute("data-preview")).toBe("image");
    // An Internal file is not watermarked, so the panel says nothing about it.
    expect(screen.queryByText(/preview as they download/)).toBeNull();
    // Zoom steps change the drawn width.
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(image.style.width).toBe("125%"));
  });

  it("draws what the route delivered: a classified image arrives as the watermarked PDF", async () => {
    fetchMock.mockResolvedValue(
      delivered("%PDF-1.7 marked", "application/pdf", "Stage plot (watermarked).pdf"),
    );
    show(
      createElement(FilePreviewPanel, {
        src: "/files/v-5",
        name: "Stage plot.png",
        contentType: "image/png",
        classification: "Confidential",
        onClose: () => undefined,
      }),
    );
    expect(
      screen.getByText(
        "Confidential and Restricted files preview as they download: with your email and the time on every page.",
      ),
    ).toBeTruthy();
    const page = await screen.findByRole("img", { name: "Page 1 of 3" });
    expect(page.tagName).toBe("CANVAS");
    expect(new TextDecoder().decode(pdf.opened[0])).toBe("%PDF-1.7 marked");
    expect(pdf.draw).toHaveBeenCalledWith(0, page, 1);
    // The delivered copy keeps its own name, and its pages are listed.
    expect(screen.getByText("Stage plot (watermarked).pdf")).toBeTruthy();
    expect(screen.getByText("3 pages")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    expect(await screen.findByRole("img", { name: "Page 2 of 3" })).toBeTruthy();
  });

  it("says the preview failed when the route answers with an error", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    show(
      createElement(FilePreviewPanel, {
        src: "/files/v-6",
        name: "Map.pdf",
        contentType: "application/pdf",
        onClose: () => undefined,
      }),
    );
    expect(
      await screen.findByText("The preview couldn't be loaded. Try again, or download the file."),
    ).toBeTruthy();
  });
});

describe("FilePreviewButton", () => {
  it("offers Preview only for types the previewer draws or explains", () => {
    const { container } = show(
      createElement(FilePreviewButton, {
        src: "/files/v-7",
        name: "notes.txt",
        contentType: "text/plain",
      }),
    );
    expect(container.textContent).toBe("");
  });

  it("loads the panel on demand and opens it", async () => {
    fetchMock.mockResolvedValue(delivered("png-bytes", "image/png"));
    show(
      createElement(FilePreviewButton, {
        src: "/files/v-8",
        name: "Badge.png",
        contentType: "image/png",
      }),
    );
    const button = screen.getByRole("button", { name: "Preview" });
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(button);
    expect(await screen.findByRole("dialog", { name: "Badge.png" })).toBeTruthy();
    expect(await screen.findByRole("img", { name: "Badge.png" })).toBeTruthy();
  });

  it("previews an attachment's current version through its delivery route", async () => {
    fetchMock.mockResolvedValue(delivered("png-bytes", "image/png"));
    show(
      createElement(AttachmentPreview, {
        attachment: {
          title: "Badge",
          classification: "Internal",
          current: {
            id: "version 9",
            filename: "badge.png",
            contentType: "image/png",
            sizeBytes: 1024,
          },
        } as unknown as Parameters<typeof AttachmentPreview>[0]["attachment"],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("img", { name: "badge.png" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/files/version%209");
  });

  it("shows nothing for an attachment without a clean version", () => {
    const { container } = show(
      createElement(AttachmentPreview, {
        attachment: { title: "Pending", classification: "Internal", current: null },
      }),
    );
    expect(container.textContent).toBe("");
  });
});
