import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Deliver from "@/lib/files/deliver";

/**
 * The share link file route (Section 8.6, migration 1380). A watermarked copy links to the file in
 * Atlas, /files/{version}, never to the share link whose token would let a forwarded copy open it
 * again (A69-013), and a failure goes to the redacting logger, never the console (A69-012).
 */
const TOKEN = `xshr_${"ab".repeat(32)}`;
const VERSION = "0192f0a0-0000-7000-8000-000000000001";

const state = vi.hoisted(() => ({
  opened: null as unknown,
  copies: [] as { sourceUrl: string; watermark: boolean }[],
  logged: [] as { message: string; fields: Record<string, unknown> }[],
}));

vi.mock("next-intl/server", () => ({ getLocale: async () => "en-US" }));
vi.mock("@/lib/env", () => ({
  env: () => ({
    SUPABASE_URL: "https://db.atlas.test",
    ATLAS_SITE_URL: "https://atlas.example.test",
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => ({}) }));
vi.mock("@/lib/observability", () => ({
  observability: {
    logger: {
      error: (message: string, fields: Record<string, unknown>) =>
        state.logged.push({ message, fields }),
    },
  },
}));
vi.mock("@xos/data/share-links", () => ({
  SHARE_TOKEN: /^xshr_[0-9a-f]{64}$/,
  openShareLink: async () => state.opened,
  fetchTicketFile: async () => ({
    ok: true,
    data: { bytes: new Uint8Array([1]), contentType: "image/png" },
  }),
}));
vi.mock("@/lib/files/deliver", async (importOriginal) => {
  const actual = await importOriginal<typeof Deliver>();
  return {
    ...actual,
    copyForViewer: async (input: { sourceUrl: string; watermark: boolean }) => {
      state.copies.push({ sourceUrl: input.sourceUrl, watermark: input.watermark });
      return { bytes: new Uint8Array([1]), filename: "stage.pdf", contentType: "application/pdf" };
    },
  };
});

const { POST } = await import("@/app/share/[token]/file/route");
const { copyRecordUrl } = await import("@/lib/files/deliver");

function opened(versionId: string | null) {
  return {
    ok: true,
    data: {
      refused: false,
      ticket: `xdlt_${"cd".repeat(32)}`,
      orgName: "Northwind Live",
      filename: "stage.png",
      contentType: "image/png",
      sizeBytes: 1,
      classification: "Confidential",
      watermark: true,
      recipientEmail: "ana@venue.test",
      expiresAt: null,
      versionId,
    },
  };
}

function post(): Promise<Response> {
  const form = new FormData();
  form.set("accessCode", "042424");
  return POST(
    new Request(`https://atlas.example.test/share/${TOKEN}/file`, { method: "POST", body: form }),
    {
      params: Promise.resolve({ token: TOKEN }),
    } as never,
  );
}

beforeEach(() => {
  state.copies = [];
  state.logged = [];
});

describe("share link file route", () => {
  it("links a watermarked copy to the file in Atlas, never to the share link", async () => {
    state.opened = opened(VERSION);
    expect((await post()).status).toBe(200);
    expect(state.copies).toEqual([
      { sourceUrl: `https://atlas.example.test/files/${VERSION}`, watermark: true },
    ]);
    expect(JSON.stringify(state.copies)).not.toContain(TOKEN);
  });

  it("links to the Atlas home page when the database names no version", async () => {
    state.opened = opened(null);
    await post();
    expect(state.copies.map((c) => c.sourceUrl)).toEqual(["https://atlas.example.test/"]);
  });

  it("logs a failed open through the redacting logger, not the console", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.opened = { ok: false, error: { kind: "unexpected", message: "boom" } };
    expect((await post()).status).toBe(500);
    expect(state.logged).toEqual([
      {
        message: "share link open failed",
        fields: { route: "/share/[token]/file", error: { kind: "unexpected", message: "boom" } },
      },
    ]);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("builds the record link from the version alone", () => {
    expect(copyRecordUrl(VERSION, "https://atlas.example.test")).toBe(
      `https://atlas.example.test/files/${VERSION}`,
    );
    expect(copyRecordUrl(null, "https://atlas.example.test/")).toBe("https://atlas.example.test/");
  });
});
