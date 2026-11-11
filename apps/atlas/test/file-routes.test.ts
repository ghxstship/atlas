import { getMessages } from "@xos/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { twoPagePdf, watermarks } from "./fixtures/pdf";

/**
 * The two routes that deliver classified files (Section 8.6, finding A65-016; A103). A copy that
 * must carry the watermark comes from the file-download function only with the handover secret
 * (2041); without it, or when the copy cannot carry the mark, the route refuses in the reader's
 * language and never sends the stored bytes.
 */
const SECRET = "h".repeat(64);
const TOKEN = `xshr_${"a".repeat(64)}`;
const VERSION = "0b8f6a52-6c1e-4f43-9d55-0d2b5d3f9a10";

const state = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  viewer: null as unknown,
}));
const data = vi.hoisted(() => ({
  record: vi.fn(),
  open: vi.fn(),
  fetchFile: vi.fn(),
}));

vi.mock("next-intl/server", () => ({ getLocale: async () => "en-US" }));
vi.mock("@/lib/env", () => ({ env: () => state.env }));
vi.mock("@/lib/shell/context", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => ({}) }));
vi.mock("@xos/data/share-links", async (original) => ({
  ...((await original()) as object),
  recordFileDownload: data.record,
  openShareLink: data.open,
  fetchTicketFile: data.fetchFile,
}));

const { GET: download } = await import("@/app/files/[version]/route");
const { POST: openFile } = await import("@/app/share/[token]/file/route");

const copy = getMessages("en-US").compliance.download as Record<string, string>;

/** The viewer's client: the version row, the org name, and Storage for files that need no ticket. */
function viewerWith(contentType: string, stored: Uint8Array | null) {
  const storage = vi.fn(async () =>
    stored
      ? { data: new Blob([new Uint8Array(stored)]), error: null }
      : { data: null, error: { message: "denied" } },
  );
  const row = (result: unknown) => {
    const query: Record<string, unknown> = {
      select: () => query,
      eq: () => query,
      is: () => query,
      maybeSingle: async () => ({ data: result, error: null }),
    };
    return query;
  };
  const db = {
    from: (table: string) =>
      row(
        table === "attachment_versions"
          ? {
              id: VERSION,
              org_id: "org-1",
              object_name: "org-1/v.pdf",
              filename: "Rider.pdf",
              content_type: contentType,
              scan_status: "Clean",
            }
          : { name: "Northwind Live" },
      ),
    storage: { from: () => ({ download: storage }) },
  };
  state.viewer = { person: { id: "p1" }, email: "bob@northwind.test", db };
  return storage;
}

const fileDownload = () =>
  download(new Request(`https://atlas.test/files/${VERSION}`), {
    params: Promise.resolve({ version: VERSION }),
  } as never);

const shareOpen = () => {
  const form = new FormData();
  form.set("accessCode", "042424");
  return openFile(
    new Request(`https://atlas.test/share/${TOKEN}/file`, { method: "POST", body: form }),
    {
      params: Promise.resolve({ token: TOKEN }),
    } as never,
  );
};

const handed = (bytes: Uint8Array, watermark: boolean) => ({
  ok: true,
  data: { bytes, contentType: "application/pdf", watermark },
});

beforeEach(() => {
  state.env = {
    SUPABASE_URL: "https://db.test",
    ATLAS_SITE_URL: "https://atlas.test",
    XOS_FILE_HANDOVER_SECRET: SECRET,
  };
  data.record.mockReset();
  data.open.mockReset();
  data.fetchFile.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("/files/{version}", () => {
  const ticketed = {
    ok: true,
    data: {
      classification: "Confidential",
      watermark: true,
      viewerEmail: "bob@northwind.test",
      ticket: "xdlt_t",
    },
  };

  it("receives a Confidential PDF by ticket with the handover secret and marks every page", async () => {
    const storage = viewerWith("application/pdf", null);
    data.record.mockResolvedValue(ticketed);
    data.fetchFile.mockResolvedValue(handed(twoPagePdf(), true));
    const response = await fileDownload();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("Rider-watermarked.pdf");
    expect(data.fetchFile).toHaveBeenCalledWith("https://db.test/functions/v1", "xdlt_t", {
      handoverSecret: SECRET,
    });
    expect(storage).not.toHaveBeenCalled();
    const body = new Uint8Array(await response.arrayBuffer());
    expect(watermarks(body, "Downloaded by bob@northwind.test on ").marks).toBe(4);
  });

  it("refuses, in the reader's language, when the handover is not set up or fails", async () => {
    viewerWith("application/pdf", twoPagePdf());
    data.record.mockResolvedValue(ticketed);
    state.env = { ...state.env, XOS_FILE_HANDOVER_SECRET: undefined };
    let response = await fileDownload();
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(copy["download_watermark_unavailable"]);
    expect(data.fetchFile).not.toHaveBeenCalled();

    state.env = { ...state.env, XOS_FILE_HANDOVER_SECRET: SECRET };
    data.fetchFile.mockResolvedValue({ ok: false, error: { kind: "not-found" } });
    response = await fileDownload();
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(copy["download_watermark_unavailable"]);
  });

  it("refuses an encrypted PDF rather than sending it unmarked", async () => {
    viewerWith("application/pdf", null);
    data.record.mockResolvedValue(ticketed);
    data.fetchFile.mockResolvedValue(handed(twoPagePdf({ encrypted: true }), true));
    const response = await fileDownload();
    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe(copy["download_watermark_unsupported"]);
  });

  it("answers the database's refusal, and reads a file that needs no watermark from Storage", async () => {
    const storage = viewerWith("application/pdf", twoPagePdf());
    data.record.mockResolvedValueOnce({
      ok: false,
      error: { kind: "refusal", rule: "download_confidential", message: "download_confidential" },
    });
    const refused = await fileDownload();
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe(copy["download_confidential"]);

    data.record.mockResolvedValueOnce({
      ok: true,
      data: { classification: "Internal", watermark: false, viewerEmail: null, ticket: null },
    });
    const stored = await fileDownload();
    expect(stored.status).toBe(200);
    expect(stored.headers.get("Content-Disposition")).toContain('filename="Rider.pdf"');
    expect(storage).toHaveBeenCalledWith("org-1/v.pdf");
    expect(data.fetchFile).not.toHaveBeenCalled();
  });
});

describe("/share/{token}/file", () => {
  const opened = (watermark: boolean) => ({
    ok: true,
    data: {
      refused: false,
      ticket: "xdlt_t",
      orgName: "Northwind Live",
      filename: "Rider.pdf",
      contentType: "application/pdf",
      sizeBytes: 1200,
      classification: watermark ? "Confidential" : "Internal",
      watermark,
      recipientEmail: watermark ? "ana@venue.test" : null,
      expiresAt: null,
    },
  });
  const reason = (response: Response) =>
    new URL(response.headers.get("Location") ?? "", "https://atlas.test").searchParams.get(
      "reason",
    );

  it("hands a Confidential PDF to the recipient marked with their email", async () => {
    data.open.mockResolvedValue(opened(true));
    data.fetchFile.mockResolvedValue(handed(twoPagePdf(), true));
    const response = await shareOpen();
    expect(response.status).toBe(200);
    expect(data.fetchFile).toHaveBeenCalledWith("https://db.test/functions/v1", "xdlt_t", {
      handoverSecret: SECRET,
    });
    const body = new Uint8Array(await response.arrayBuffer());
    expect(watermarks(body, "Downloaded by ana@venue.test on ")).toEqual({ marks: 4, pages: 2 });
  });

  it("sends the visitor back when the handover is not set up, or fails", async () => {
    data.open.mockResolvedValue(opened(true));
    state.env = { ...state.env, XOS_FILE_HANDOVER_SECRET: undefined };
    let response = await shareOpen();
    expect(response.status).toBe(303);
    expect(reason(response)).toBe("share_link_unavailable");
    expect(data.fetchFile).not.toHaveBeenCalled();

    state.env = { ...state.env, XOS_FILE_HANDOVER_SECRET: SECRET };
    data.fetchFile.mockResolvedValue({ ok: false, error: { kind: "not-found" } });
    response = await shareOpen();
    expect(reason(response)).toBe("share_link_unavailable");
    data.open.mockResolvedValue(opened(false));
    response = await shareOpen();
    expect(reason(response)).toBe("share_link_invalid");
  });

  it("refuses an encrypted PDF with share_link_watermark_unsupported", async () => {
    data.open.mockResolvedValue(opened(true));
    data.fetchFile.mockResolvedValue(handed(twoPagePdf({ encrypted: true }), true));
    const response = await shareOpen();
    expect(response.status).toBe(303);
    expect(reason(response)).toBe("share_link_watermark_unsupported");
  });

  it("marks a file the handover says must now carry the watermark, though the open said not", async () => {
    data.open.mockResolvedValue(opened(false));
    data.fetchFile.mockResolvedValue(handed(twoPagePdf(), true));
    const response = await shareOpen();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("Rider-watermarked.pdf");
  });
});
