import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bookCoverModel,
  bookDocuments,
  generateBook,
  type DocumentBook,
} from "../../src/documents/books.ts";
import { buildDocumentModel, documentFileName } from "../../src/documents/generate.ts";
import { MAX_BOOK_DOCUMENTS, type DocumentModel } from "../../src/documents/model.ts";
import { bookLayout, renderBookPdf, renderDocumentPdf } from "../../src/documents/render.ts";
import { loadDocumentData } from "../../src/documents/sources.ts";
import { DAY_SHEET_V2_FROM, type DocumentDataMap } from "../../src/documents/templates.ts";
import { fakeClient, okResponse } from "../fake-client.ts";
import { BRAND, FIXTURES, NOW } from "./fixtures.ts";

/**
 * B7 (RRR-231, ADR 0146): day sheet version 2 and the copy for an audience, the wrap-up report's sections, and
 * books: their cover and contents, two-pass page numbers, the structure tree, the outline, the cap, and which
 * documents a book selects as the caller.
 */

const EN: unknown = JSON.parse(
  readFileSync(new URL("../../../i18n/messages/en-US/documents.json", import.meta.url), "utf8"),
);
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
const pages = (pdf: string) => (pdf.match(/\/Type \/Page\b(?!s)/g) ?? []).length;
const options = {
  locale: "en-US",
  messages: EN,
  brand: BRAND,
  recordUrl: "https://atlas.example.test/r",
  now: NOW,
};

function strings(model: DocumentModel): string[] {
  return model.blocks.flatMap((b) => {
    if (b.kind === "heading" || b.kind === "paragraph") return [b.text];
    if (b.kind === "fields") return [b.caption, ...b.fields.flatMap((f) => [f.label, f.value])];
    if (b.kind === "table")
      return [
        b.caption,
        b.empty,
        ...b.columns.map((c) => c.label),
        ...b.rows.flat(),
        ...(b.footer ?? []).flat(),
      ];
    if (b.kind === "contents") return [b.caption, ...b.entries.map((e) => e.title)];
    return [];
  });
}

const SHEET = FIXTURES["day-sheet"];
const RUN = FIXTURES["run-of-show"];
const SCHEDULE: NonNullable<DocumentDataMap["day-sheet"]["schedule"]> = {
  calls: [
    {
      shiftId: "s1",
      startsAt: "2026-10-24T12:00:00Z",
      endsAt: "2026-10-24T20:00:00Z",
      roleCode: "5000.50.01",
      roleTitle: "Production Assistant",
      personName: "Ana Ruiz",
      membershipId: "m1",
    },
    {
      shiftId: "s2",
      startsAt: "2026-10-24T13:00:00Z",
      endsAt: "2026-10-24T21:00:00Z",
      roleCode: "5000.51.02",
      roleTitle: null,
      personName: null,
      membershipId: null,
    },
  ],
  records: [
    {
      id: "r1",
      kind: "Meeting",
      title: "Lighting focus",
      at: "2026-10-24T18:00:00Z",
      startTbc: true,
      state: "Scheduled",
      recordKey: "NWF26-41",
    },
    {
      id: "r2",
      kind: "Deadline",
      title: "Advance due",
      at: "2026-10-24T20:00:00Z",
      startTbc: false,
      state: "Canceled",
      recordKey: "NWF26-42",
    },
  ],
  runs: [
    {
      run: RUN.run,
      cues: RUN.cues,
      calls: [
        { id: "c1", cueId: RUN.cues[0]?.id ?? "q1", kind: "Lighting", instruction: "LX 12 GO" },
        { id: "c2", cueId: RUN.cues[0]?.id ?? "q1", kind: "Audio", instruction: "Walk-in out" },
        { id: "c3", cueId: RUN.cues[1]?.id ?? "q2", kind: "Audio", instruction: "Playback 1" },
      ],
    },
  ],
};

describe("day sheet version 2 (B7)", () => {
  const before = { ...SHEET.sheet, publishedAt: "2026-10-23T20:00:00Z" };
  const after = { ...SHEET.sheet, publishedAt: DAY_SHEET_V2_FROM };

  it("keeps version 1 for an unfiltered sheet issued before DAY_SHEET_V2_FROM, and version 2 after it", () => {
    expect(
      buildDocumentModel("day-sheet", { ...SHEET, sheet: before, schedule: SCHEDULE }, options)
        .facts.templateVersion,
    ).toBe(1);
    const v2 = buildDocumentModel(
      "day-sheet",
      { ...SHEET, sheet: after, schedule: SCHEDULE },
      options,
    );
    expect(v2.facts.templateVersion).toBe(2);
    expect(
      v2.blocks
        .filter((b) => b.kind === "heading" || b.kind === "table")
        .map((b) => ("text" in b ? b.text : b.caption)),
    ).toEqual(["Notes for the day", "Calls", "Schedule", `Cues: ${RUN.run.name}`]);
  });

  it("prints version 2 for an audience, even for a sheet issued before it", () => {
    const model = buildDocumentModel(
      "day-sheet",
      {
        ...SHEET,
        sheet: before,
        schedule: SCHEDULE,
        audience: { label: "Load-In Crew", showDepartment: null },
      },
      options,
    );
    expect(model.facts.templateVersion).toBe(2);
    expect(model.title).toContain("for Load-In Crew");
    expect(strings(model)).toEqual(
      expect.arrayContaining(["For", "Load-In Crew", "Open", "TBC", "Advance due (Canceled)"]),
    );
  });

  it("keeps only the show department's cues and calls", () => {
    const model = buildDocumentModel(
      "day-sheet",
      {
        ...SHEET,
        sheet: after,
        schedule: SCHEDULE,
        audience: { label: null, showDepartment: "Lighting" },
      },
      options,
    );
    const cues = model.blocks.find((b) => b.kind === "table" && b.caption.startsWith("Cues"));
    if (cues?.kind !== "table") throw new Error("cues");
    expect(cues.rows).toHaveLength(1);
    expect(cues.rows[0]?.[4]).toBe("Lighting: LX 12 GO");
    expect(strings(model)).toContain("Show department");
  });

  it("shows each empty table's own line", () => {
    const model = buildDocumentModel(
      "day-sheet",
      { ...SHEET, sheet: after, schedule: { calls: [], records: [], runs: [] } },
      options,
    );
    expect(strings(model)).toEqual(
      expect.arrayContaining([
        "No calls on this day.",
        "No meetings, milestones or deadlines on this day.",
        "No cues on this day.",
      ]),
    );
  });

  it("names a filtered copy's file after its audience", () => {
    expect(documentFileName("day-sheet", "NWF26-DS-2026-10-24", "a4", "Load-In Crew")).toBe(
      "day-sheet-NWF26-DS-2026-10-24-load-in-crew-a4.pdf",
    );
  });
});

describe("the wrap-up report (B7)", () => {
  const WRAP = FIXTURES["wrap-up-report"];

  it("prints its sections in order, the Aurora label and Unmeasured never as 0", () => {
    const model = buildDocumentModel("wrap-up-report", WRAP, options);
    expect(model.facts.recordKey).toBe(`${WRAP.project.key}-WRAP`);
    expect(
      model.blocks.filter((b) => b.kind === "heading").map((b) => ("text" in b ? b.text : "")),
    ).toEqual([
      "Management summary",
      "Budget against actuals",
      "Attendance",
      "Sustainability and carbon",
      "Incidents",
    ]);
    const all = strings(model);
    expect(all.some((s) => s.startsWith("Drafted with Aurora and reviewed by Ana Ruiz on"))).toBe(
      true,
    );
    expect(all).toContain("Unmeasured");
    expect(all).toContain("9,800 people");
    expect(all).not.toContain("0 kg CO2e");
    expect(all).toContain("Debrief");
    expect(all).toContain("Add a second spotter on the downstage truss for load-out.");
  });

  it("says who wrote a summary drafted without Aurora, and when there is none", () => {
    const summary = WRAP.summary === "unavailable" || WRAP.summary === null ? null : WRAP.summary;
    if (!summary) throw new Error("fixture");
    expect(
      strings(
        buildDocumentModel(
          "wrap-up-report",
          { ...WRAP, summary: { ...summary, aiDrafted: false } },
          options,
        ),
      ).some((s) => s.startsWith("Written by Ana Ruiz")),
    ).toBe(true);
    expect(
      strings(buildDocumentModel("wrap-up-report", { ...WRAP, summary: null }, options)),
    ).toContain("No management summary yet.");
  });

  it("prints Not included for a section the reader cannot read, and the no-baseline line", () => {
    const model = buildDocumentModel(
      "wrap-up-report",
      {
        ...WRAP,
        summary: "unavailable",
        budget: "unavailable",
        measurements: "unavailable",
        incidents: "unavailable",
      },
      options,
    );
    expect(strings(model)).toEqual(
      expect.arrayContaining([
        "Not included: you cannot read Management summary.",
        "Not included: you cannot read Budget against actuals.",
        "Not included: you cannot read Attendance.",
        "Not included: you cannot read Incidents.",
      ]),
    );
    const budget = WRAP.budget === "unavailable" ? null : WRAP.budget;
    if (!budget) throw new Error("fixture");
    const noBaseline = buildDocumentModel(
      "wrap-up-report",
      { ...WRAP, budget: { ...budget, hasBaseline: false } },
      options,
    );
    expect(strings(noBaseline).some((s) => s.includes("gate 3 baseline"))).toBe(true);
  });
});

describe("the wrap-up loader (B7)", () => {
  const project = okResponse({
    id: "p1",
    project_key: "NWF26",
    name: "Northwind Festival",
    time_zone: "America/New_York",
  });

  it("leaves the budget and the summary out without finance.journal.read in the org", async () => {
    const { db } = fakeClient({
      "from:projects": [project],
      "rpc:my_capabilities_on_project": [
        okResponse(["finance.budget.read", "projects.gate.read", "safety.incident.read"]),
      ],
      "from:project_debriefs": [okResponse(null)],
      "from:project_measurement_summary": [okResponse([])],
      "from:measurement_metrics": [okResponse([])],
      "from:measurement_units": [okResponse([])],
      "from:measurement_metric_tags": [okResponse([])],
      "from:incidents": [okResponse([])],
      "from:std_enumeration": [okResponse([])],
      "from:xpms.std_enumeration": [okResponse([])],
    });
    const loaded = await loadDocumentData(db, "org-1", "wrap-up-report", "p1", {
      ledgerRead: false,
    });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    expect(loaded.data.budget).toBe("unavailable");
    expect(loaded.data.summary).toBe("unavailable");
    expect(loaded.data.measurements).not.toBe("unavailable");
    expect(loaded.data.incidents).not.toBe("unavailable");
  });

  it("reads nothing a reader lacks the capability for", async () => {
    const { db, calls } = fakeClient({
      "from:projects": [project],
      "rpc:my_capabilities_on_project": [okResponse([])],
      "from:project_debriefs": [okResponse(null)],
    });
    const loaded = await loadDocumentData(db, "org-1", "wrap-up-report", "p1", {
      ledgerRead: true,
    });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    expect([
      loaded.data.budget,
      loaded.data.measurements,
      loaded.data.incidents,
      loaded.data.summary,
    ]).toEqual(["unavailable", "unavailable", "unavailable", "unavailable"]);
    expect(calls.map((c) => c.target)).not.toContain("from:posting_lines");
  });
});

/** A small model with a given number of body rows, so its page count is known. */
function section(i: number, rows: number): DocumentModel {
  const base = buildDocumentModel("call-sheet", FIXTURES["call-sheet"], options);
  return {
    ...base,
    title: `Call sheet ${i}`,
    facts: { ...base.facts, recordKey: `NWF26-CS-${i}` },
    blocks: [
      {
        kind: "table",
        caption: "Calls",
        columns: [{ label: "Row" }, { label: "Person" }],
        rows: Array.from({ length: rows }, (_, r) => [String(r + 1), `Crew member ${r + 1}`]),
        empty: "None",
      },
    ],
  };
}

function cover(sections: readonly DocumentModel[]): DocumentModel {
  return bookCoverModel(
    {
      project: FIXTURES["day-sheet"].project,
      book: {
        id: "b0000000-1234-4000-8000-000000000001",
        name: "Opening week",
        kind: "Tour Book",
        startsOn: "2026-10-22",
        endsOn: "2026-10-24",
        sections: ["day-sheet", "call-sheet"],
        createdAt: "2026-10-01T00:00:00Z",
      },
      contents: sections.map((m) => ({ title: m.title, recordKey: m.facts.recordKey, page: 0 })),
      unreadable: 1,
      unpublished: 2,
    },
    { ...options, paper: "letter" },
  );
}

describe("books (B7)", () => {
  it("keys the cover by the book and lists what was left out", () => {
    const c = cover([section(1, 2)]);
    expect(c.kind).toBe("document-book");
    expect(c.facts.recordKey).toMatch(/^NWF26-BK-b0000000$/);
    expect(strings(c)).toEqual(
      expect.arrayContaining([
        "Contents",
        "Records you cannot open, left out: 1.",
        "Day and call sheets not yet published, left out: 2.",
      ]),
    );
  });

  it("numbers the contents with the page each document starts on, as drawing each alone counts them", async () => {
    const parts = [section(1, 3), section(2, 90), section(3, 4)];
    const book = cover(parts);
    const layout = await bookLayout(book, parts, {
      paper: "letter",
      title: "Opening week",
      lang: "en-US",
    });
    const alone = await Promise.all(
      [book, ...parts].map(async (m) =>
        pages(text(await renderDocumentPdf(m, { paper: "letter" }))),
      ),
    );
    expect(layout.counts).toEqual(alone);
    const [a = 0, b = 0, c = 0] = alone;
    expect(layout.starts).toEqual([1, 1 + a, 1 + a + b, 1 + a + b + c]);
    expect(layout.total).toBe(alone.reduce((a, b) => a + b, 0));
  }, 120_000);

  it("writes one Document, a cover Sect with a TOC and a TOCI per document, a Sect per document, an outline and book footers", async () => {
    const parts = [section(1, 3), section(2, 90)];
    const seen: [number, number][] = [];
    const spied = parts.map((m) => ({
      ...m,
      facts: {
        ...m.facts,
        labels: {
          ...m.facts.labels,
          page: (p: number, t: number) => (seen.push([p, t]), `Page ${p} of ${t}`),
        },
      },
    }));
    const book = cover(spied);
    const layout = await bookLayout(book, spied, {
      paper: "a4",
      title: "Opening week",
      lang: "en-US",
    });
    seen.length = 0;
    const pdf = text(
      await renderBookPdf(book, spied, { paper: "a4", title: "Opening week", lang: "en-US" }),
    );
    expect((pdf.match(/\/S \/Document\b/g) ?? []).length).toBe(1);
    expect((pdf.match(/\/S \/Sect\b/g) ?? []).length).toBe(3);
    expect((pdf.match(/\/S \/TOC\b/g) ?? []).length).toBe(1);
    expect((pdf.match(/\/S \/TOCI\b/g) ?? []).length).toBe(2);
    expect(pdf).toContain("/Outlines");
    expect(pages(pdf)).toBe(layout.total);
    // The documents' footers count the whole book: their pages follow the cover's, each "of" the book's total.
    const second = layout.starts[1] ?? 0;
    expect(seen.filter(([, t]) => t === layout.total).map(([p]) => p)).toEqual(
      Array.from({ length: layout.total - second + 1 }, (_, i) => second + i),
    );
  }, 120_000);

  it("refuses a section that needs the viewer watermark, and more than MAX_BOOK_DOCUMENTS", async () => {
    const watermarked = { ...section(1, 1), watermark: { text: "Downloaded by ana@example.com" } };
    await expect(
      renderBookPdf(cover([watermarked]), [watermarked], {
        paper: "letter",
        title: "x",
        lang: "en-US",
      }),
    ).rejects.toThrow(/watermark/);
    const many = Array.from({ length: MAX_BOOK_DOCUMENTS + 1 }, (_, i) => section(i, 1));
    await expect(
      bookLayout(cover(many), many, { paper: "letter", title: "x", lang: "en-US" }),
    ).rejects.toThrow(/1 to 100/);
  });

  it("renders a book of 100 documents and its cover", async () => {
    const hundred = Array.from({ length: MAX_BOOK_DOCUMENTS }, (_, i) => section(i, 1));
    const pdf = text(
      await renderBookPdf(cover(hundred), hundred, {
        paper: "letter",
        title: "Season",
        lang: "en-US",
      }),
    );
    expect((pdf.match(/\/S \/TOCI\b/g) ?? []).length).toBe(100);
    expect((pdf.match(/\/S \/Sect\b/g) ?? []).length).toBe(101);
  }, 180_000);
});

describe("which documents a book holds (B7)", () => {
  const PROJECT = {
    id: "p1",
    key: "NWF26",
    name: "Northwind Festival",
    timeZone: "America/New_York",
  };
  const sheet = (id: string, day: string, publishedAt: string | null) => ({
    id,
    project_id: "p1",
    day,
    body: "",
    published_at: publishedAt,
    updated_at: "2026-10-01T00:00:00Z",
    project: { project_key: "NWF26" },
  });
  const book = (kind: DocumentBook["kind"], sections: DocumentBook["sections"]): DocumentBook => ({
    id: "b1",
    projectId: "p1",
    name: "Week",
    kind,
    startsOn: "2026-10-22",
    endsOn: "2026-10-24",
    sections,
    createdAt: "2026-10-01T00:00:00Z",
  });

  it("orders a Tour Book by day, then section, with only published sheets, and counts the rest", async () => {
    const { db } = fakeClient({
      "from:day_sheets": [
        okResponse([
          sheet("d22", "2026-10-22", "2026-10-21T00:00:00Z"),
          sheet("d23", "2026-10-23", "2026-10-22T00:00:00Z"),
          sheet("d24", "2026-10-24", null),
        ]),
      ],
      "from:call_sheets": [okResponse([sheet("c22", "2026-10-22", "2026-10-21T00:00:00Z")])],
    });
    const picked = await bookDocuments(
      db,
      "org-1",
      book("Tour Book", ["day-sheet", "call-sheet"]),
      PROJECT,
    );
    if (!picked.ok) throw new Error("select");
    expect(picked.data.documents.map((d) => d.id)).toEqual(["d22", "c22", "d23"]);
    expect(picked.data.unpublished).toBe(1);
  });

  it("orders a Production Book by section, then day, with the final cost report once", async () => {
    const { db } = fakeClient({
      "from:day_sheets": [
        okResponse([
          sheet("d23", "2026-10-23", "2026-10-22T00:00:00Z"),
          sheet("d22", "2026-10-22", "2026-10-21T00:00:00Z"),
        ]),
      ],
    });
    const picked = await bookDocuments(
      db,
      "org-1",
      book("Production Book", ["final-cost-report", "day-sheet"]),
      PROJECT,
    );
    if (!picked.ok) throw new Error("select");
    expect(picked.data.documents.map((d) => [d.kind, d.id])).toEqual([
      ["final-cost-report", "p1"],
      ["day-sheet", "d22"],
      ["day-sheet", "d23"],
    ]);
  });

  it("answers invalid above MAX_BOOK_DOCUMENTS, and not found for a book of another org", async () => {
    const many = Array.from({ length: MAX_BOOK_DOCUMENTS + 1 }, (_, i) =>
      sheet(`d${i}`, "2026-10-22", "2026-10-21T00:00:00Z"),
    );
    const bookRow = {
      id: "b1",
      project_id: "p1",
      name: "Week",
      book_kind: "Tour Book",
      starts_on: "2026-10-22",
      ends_on: "2026-10-24",
      created_at: "2026-10-01T00:00:00Z",
      sections: [{ document_kind: "day-sheet", position: 1, deleted_at: null }],
    };
    const input = {
      orgId: "org-1",
      orgName: "Northwind Live",
      bookId: "b1",
      locale: "en-US",
      messages: EN,
      paper: "letter" as const,
      recordUrl: () => "u",
      bookUrl: () => "u",
    };
    const tooMany = fakeClient({
      "from:document_books": [okResponse(bookRow)],
      "from:projects": [
        okResponse({
          id: "p1",
          project_key: "NWF26",
          name: "Northwind Festival",
          time_zone: "America/New_York",
        }),
      ],
      "from:day_sheets": [okResponse(many)],
    });
    expect(await generateBook({ ...input, db: tooMany.db })).toMatchObject({
      ok: false,
      error: { kind: "invalid" },
    });
    const other = fakeClient({ "from:document_books": [okResponse(null)] });
    expect(await generateBook({ ...input, db: other.db })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });
});
