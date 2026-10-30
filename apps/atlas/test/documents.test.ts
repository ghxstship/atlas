import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DOCUMENT_KINDS } from "@xos/data/documents/model";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { atlasRecordPath, documentHref } from "@/lib/documents/links";

const state = vi.hoisted(() => ({ ctx: null as unknown }));
const gen = vi.hoisted(() => ({ single: vi.fn(), batch: vi.fn(), book: vi.fn() }));

vi.mock("next-intl/server", () => ({ getLocale: async () => "en-US" }));
vi.mock("@/lib/env", () => ({ env: () => ({ ATLAS_SITE_URL: "https://atlas.example.test" }) }));
vi.mock("@/lib/shell/context", () => ({ getOrgContext: async () => state.ctx }));
vi.mock("@xos/data/documents/generate", () => ({
  generateDocument: gen.single,
  generateBadgeBatch: gen.batch,
  watermarkText: () => "marked",
}));
vi.mock("@xos/data/documents/books", () => ({ generateBook: gen.book }));
vi.mock("@/lib/documents/wrap-up", () => ({
  wrapUpLoadOptions: async () => ({ ledgerRead: false, unitPreference: "metric" }),
}));

const { GET: single } = await import("@/app/[org]/documents/[kind]/[id]/route");
const { GET: badges } = await import("@/app/[org]/documents/badges/route");
const { GET: books } = await import("@/app/[org]/documents/books/[id]/route");

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
    const [route = ""] = path.slice("/acme/".length).split("?");
    // A project tab (the wrap-up, B7) lives under the project's dynamic segment.
    const file = route.replace(/^p\/NWF26\//, "p/[projectKey]/");
    expect(existsSync(`${app}${file}/page.tsx`), route).toBe(true);
    expect(path).toMatch(/\?(peek|project|wrap)=/);
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

describe("day sheets for an audience and books (B7)", () => {
  const ctx = {
    org: { id: "org-1", slug: "acme", name: "Acme", roles: [] },
    viewer: { db: {}, email: "a@example.test", userId: "u1" },
  };
  const ID = "0190a000-0000-7000-8000-000000000001";
  const TEAM = "0190a000-0000-7000-8000-0000000000aa";

  beforeEach(() => {
    state.ctx = ctx;
    gen.single.mockReset().mockResolvedValue({
      ok: true,
      data: { bytes: new Uint8Array([37, 80, 68, 70]), fileName: "f.pdf", templateVersion: 2 },
    });
    gen.book.mockReset().mockResolvedValue({
      ok: true,
      data: {
        stream: new Blob([new Uint8Array([37, 80, 68, 70])]).stream(),
        fileName: "book-NWF26-BK-0190a000-letter.pdf",
        rendered: 5,
        skipped: 2,
      },
    });
  });

  const open = (kind: string, query: string) =>
    single(new Request(`http://localhost/acme/documents/${kind}/${ID}${query}`), {
      params: Promise.resolve({ org: "acme", kind, id: ID }),
    } as Parameters<typeof single>[1]);
  const book = (id: string, query = "") =>
    books(new Request(`http://localhost/acme/documents/books/${id}${query}`), {
      params: Promise.resolve({ org: "acme", id }),
    } as Parameters<typeof books>[1]);

  it("passes a team or a department, and a show department, to the day sheet's loader", async () => {
    const response = await open("day-sheet", `?team=${TEAM.toUpperCase()}&dept=lighting&paper=a4`);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Document-Template-Version")).toBe("2");
    expect(gen.single.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: "day-sheet",
      paper: "a4",
      load: { audience: { teamId: TEAM, departmentCode: null, showDepartment: "Lighting" } },
    });
    await open("day-sheet", "?department=5000");
    expect(gen.single.mock.calls.at(-1)?.[0]).toMatchObject({
      load: { audience: { teamId: null, departmentCode: "5000", showDepartment: null } },
    });
    await open("day-sheet", "");
    expect(gen.single.mock.calls.at(-1)?.[0]).toMatchObject({ load: {} });
  });

  it("answers 400 for both audiences or a malformed value, and ignores them on other kinds", async () => {
    for (const query of [
      `?team=${TEAM}&department=5000`,
      "?team=not-a-uuid",
      "?department=5100",
      "?department=50",
      "?dept=catering",
    ]) {
      expect((await open("day-sheet", query)).status, query).toBe(400);
    }
    expect(gen.single).not.toHaveBeenCalled();
    expect((await open("call-sheet", "?team=not-a-uuid")).status).toBe(200);
    gen.single.mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "refusal",
        rule: "day_sheet_audience",
        message: "That department does not exist.",
      },
    });
    expect((await open("day-sheet", "?department=9000")).status).toBe(400);
    gen.single.mockResolvedValueOnce({ ok: false, error: { kind: "not-found" } });
    expect((await open("day-sheet", `?team=${TEAM}`)).status).toBe(404);
  });

  it("loads the wrap-up report with the reader's ledger reach and units", async () => {
    await open("wrap-up-report", "");
    expect(gen.single.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: "wrap-up-report",
      load: { ledgerRead: false, unitPreference: "metric" },
    });
  });

  it("streams a book with what it left out, and answers 413 above 100 documents and 404 for another org's", async () => {
    const response = await book(ID, "?paper=a4");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="book-NWF26-BK-0190a000-letter.pdf"',
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Book-Skipped")).toBe("2");
    expect(gen.book.mock.calls[0]?.[0]).toMatchObject({ orgId: "org-1", bookId: ID, paper: "a4" });
    gen.book.mockResolvedValueOnce({ ok: false, error: { kind: "invalid", message: "too many" } });
    expect((await book(ID)).status).toBe(413);
    gen.book.mockResolvedValueOnce({ ok: false, error: { kind: "not-found" } });
    expect((await book(ID)).status).toBe(404);
    expect((await book("not-a-book")).status).toBe(404);
    state.ctx = null;
    expect((await book(ID)).status).toBe(404);
  });
});
