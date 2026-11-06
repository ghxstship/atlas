import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DOCUMENT_KINDS } from "@xos/data/documents/model";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { atlasRecordPath, documentHref } from "@/lib/documents/links";

const state = vi.hoisted(() => ({ ctx: null as unknown }));
const gen = vi.hoisted(() => ({ single: vi.fn(), batch: vi.fn() }));

vi.mock("next-intl/server", () => ({ getLocale: async () => "en-US" }));
vi.mock("@/lib/env", () => ({ env: () => ({ ATLAS_SITE_URL: "https://atlas.example.test" }) }));
vi.mock("@/lib/shell/context", () => ({ getOrgContext: async () => state.ctx }));
vi.mock("@xos/data/documents/generate", () => ({
  generateDocument: gen.single,
  generateBadgeBatch: gen.batch,
  watermarkText: () => "marked",
}));

const { GET: single } = await import("@/app/[org]/documents/[kind]/[id]/route");
const { GET: badges } = await import("@/app/[org]/documents/badges/route");

const app = fileURLToPath(new URL("../app/[org]/", import.meta.url));

describe("generated document links (Section 11.9)", () => {
  it("serves every document from the org's documents route", () => {
    expect(documentHref("acme", "purchase-order", "po 1")).toBe(
      "/acme/documents/purchase-order/po%201",
    );
    expect(existsSync(`${app}documents/[kind]/[id]/route.ts`)).toBe(true);
  });

  it.each(DOCUMENT_KINDS)("links the %s QR code to an Atlas page that exists", (kind) => {
    const path = atlasRecordPath("acme", kind, {
      id: "id-1",
      recordKey: "NWF26-7",
      projectKey: "NWF26",
    });
    expect(path.startsWith("/acme/")).toBe(true);
    const [route] = path.slice("/acme/".length).split("?");
    expect(existsSync(`${app}${route}/page.tsx`), route).toBe(true);
    expect(path).toMatch(/\?(peek|project)=/);
  });

  it("opens a BEO by its key and the final cost report by its project", () => {
    expect(
      atlasRecordPath("acme", "beo", { id: "x", recordKey: "NWF26-7", projectKey: null }),
    ).toBe("/acme/hospitality/beos?peek=NWF26-7");
    expect(
      atlasRecordPath("acme", "final-cost-report", {
        id: "p",
        recordKey: "k",
        projectKey: "NWF26",
      }),
    ).toBe("/acme/reports/final-cost-report?project=NWF26");
  });

  it("has no page of its own under the org, only the route handler", () => {
    expect(readdirSync(`${app}documents/[kind]/[id]`)).toEqual(["route.ts"]);
  });
});

describe("document routes (P5 sizes and badge batches)", () => {
  const ctx = {
    org: { id: "org-1", slug: "acme", name: "Acme" },
    viewer: { db: {}, email: "a@example.test", userId: "u1" },
  };
  const ID = "0190a000-0000-7000-8000-000000000001";
  const ID2 = "0190a000-0000-7000-8000-000000000002";

  beforeEach(() => {
    state.ctx = ctx;
    gen.single.mockReset().mockResolvedValue({
      ok: true,
      data: { bytes: new Uint8Array([37, 80, 68, 70]), fileName: "f.pdf", templateVersion: 2 },
    });
    gen.batch.mockReset().mockResolvedValue({
      ok: true,
      data: {
        stream: new Blob([new Uint8Array([37, 80, 68, 70])]).stream(),
        fileName: "credential-badges-2-cr80.pdf",
        rendered: 2,
        skipped: 1,
      },
    });
  });

  const open = (kind: string, query: string) =>
    single(new Request(`http://localhost/acme/documents/${kind}/${ID}${query}`), {
      params: Promise.resolve({ org: "acme", kind, id: ID }),
    } as Parameters<typeof single>[1]);
  const batch = (query: string) =>
    badges(new Request(`http://localhost/acme/documents/badges${query}`), {
      params: Promise.resolve({ org: "acme" }),
    } as Parameters<typeof badges>[1]);

  it("prints a badge on a card size, and any other kind on Letter when a card size is asked", async () => {
    for (const [kind, query, paper] of [
      ["credential-badge", "?paper=cr80", "cr80"],
      ["credential-badge", "?paper=a6", "a6"],
      ["credential-badge", "?paper=a4", "a4"],
      ["credential-badge", "", "letter"],
      ["invoice", "?paper=cr80", "letter"],
      ["invoice", "?paper=a6", "letter"],
      ["invoice", "?paper=a4", "a4"],
    ] as const) {
      const response = await open(kind, query);
      expect(response.status).toBe(200);
      expect(gen.single.mock.calls.at(-1)?.[0]).toMatchObject({ kind, paper });
    }
  });

  it("streams a badge batch with the count it left out", async () => {
    const response = await batch(`?id=${ID}&id=${ID2}&id=${ID.toUpperCase()}&paper=a6`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="credential-badges-2-cr80.pdf"',
    );
    expect(response.headers.get("X-Badges-Skipped")).toBe("1");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.body).toBeInstanceOf(ReadableStream);
    expect(gen.batch.mock.calls[0]?.[0]).toMatchObject({
      orgId: "org-1",
      ids: [ID, ID2, ID],
      paper: "a6",
    });
    await batch(`?id=${ID}`);
    expect(gen.batch.mock.calls[1]?.[0]).toMatchObject({ paper: "cr80" });
    await batch(`?id=${ID}&paper=legal`);
    expect(gen.batch.mock.calls[2]?.[0]).toMatchObject({ paper: "cr80" });
  });

  it("answers 400 for no id, a malformed id or more than 100, and 404 when nothing prints", async () => {
    expect((await batch("")).status).toBe(400);
    expect((await batch("?id=not-a-uuid")).status).toBe(400);
    const many = Array.from({ length: 101 }, () => `id=${ID}`).join("&");
    expect((await batch(`?${many}`)).status).toBe(400);
    expect(gen.batch).not.toHaveBeenCalled();
    gen.batch.mockResolvedValueOnce({ ok: false, error: { kind: "not-found" } });
    expect((await batch(`?id=${ID}`)).status).toBe(404);
    state.ctx = null;
    expect((await batch(`?id=${ID}`)).status).toBe(404);
  });

  it("registers the badges route next to the document route", () => {
    expect(existsSync(`${app}documents/badges/route.ts`)).toBe(true);
  });
});
