import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDocumentModel } from "../../src/documents/generate.ts";
import type { DocumentBlock } from "../../src/documents/model.ts";
import {
  parseBuildSheetOptions,
  parseSitePlanExportOptions,
  planOverlays,
} from "../../src/documents/places-templates.ts";
import { PLAN_TONES, renderDocumentPdf } from "../../src/documents/render.ts";
import { DESCRIBE } from "../../src/documents/templates.ts";
import { BRAND, DRAWING_TALL, FIXTURES, NOW, sitePlan, sitePlanShapes } from "./fixtures.ts";

const messages = (locale: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../../i18n/messages/${locale}/documents.json`, import.meta.url),
      "utf8",
    ),
  );
const EN = messages("en-US");
const ES = messages("es-US");
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

const build = <K extends "site-plan" | "signage-build-sheet">(
  kind: K,
  data = FIXTURES[kind],
  options: Record<string, string> = {},
  locale = "en-US",
) =>
  buildDocumentModel(kind, data as never, {
    locale,
    messages: locale === "en-US" ? EN : ES,
    brand: BRAND,
    recordUrl: `https://atlas.example.test/northwind/documents/${kind}`,
    now: NOW,
    options,
  });

const tables = (blocks: readonly DocumentBlock[]) =>
  blocks.filter((b): b is Extract<DocumentBlock, { kind: "table" }> => b.kind === "table");

describe("site plan export options (ADR 0031 amendment B1)", () => {
  it("parses layers, legend and pin table, falling back to the defaults", () => {
    const parsed = parseSitePlanExportOptions({
      layers: "pins,areas,nope",
      legend: "items",
      pins: "1",
    });
    expect([...parsed.layers]).toEqual(["pins", "areas"]);
    expect([parsed.legend, parsed.pinTable, parsed.units]).toEqual(["items", true, "imperial"]);
    const fallback = parseSitePlanExportOptions({ layers: "x", legend: "huge", units: "metric" });
    expect(fallback.layers.size).toBe(5);
    expect([fallback.legend, fallback.pinTable, fallback.units]).toEqual([
      "kinds",
      false,
      "metric",
    ]);
    expect(parseBuildSheetOptions({}).state).toBe("open");
    expect(parseBuildSheetOptions({ state: "printed" }).state).toBe("printed");
    expect(parseBuildSheetOptions({ state: "bogus" }).state).toBe("open");
  });

  it("draws only the chosen layers, numbering shapes after the pins", () => {
    const overlays = planOverlays(sitePlan, sitePlanShapes, new Set(["pins", "areas"]));
    expect(overlays.map((o) => o.kind)).toEqual(["area", "pin", "pin"]);
    expect(overlays[0]).toMatchObject({ kind: "area", n: 5, tone: "Accent" });
  });
});

describe("site plan document", () => {
  it("is landscape for a wide stored drawing, portrait for a tall one and for a legacy plan", () => {
    expect(DESCRIBE["site-plan"](FIXTURES["site-plan"], NOW).orientation).toBe("landscape");
    const drawing = sitePlan.drawing as NonNullable<typeof sitePlan.drawing>;
    const tall = { ...sitePlan, drawing: { ...drawing, widthPx: 1000, heightPx: 2000 } };
    expect(
      DESCRIBE["site-plan"]({ ...FIXTURES["site-plan"], plan: tall, drawing: DRAWING_TALL }, NOW)
        .orientation,
    ).toBe("portrait");
    expect(
      DESCRIBE["site-plan"]({ ...FIXTURES["site-plan"], drawing: null }, NOW).orientation,
    ).toBe("portrait");
    expect(DESCRIBE["site-plan"](FIXTURES["site-plan"], NOW).issuedAt).toBe(NOW.toISOString());
  });

  it("holds the drawing and its overlays in one plan block, with a legend of kinds or of items", () => {
    const kinds = build("site-plan");
    const plan = kinds.blocks.find((b) => b.kind === "plan");
    expect(
      plan && plan.kind === "plan" && [plan.widthPx, plan.heightPx, plan.overlays.length],
    ).toEqual([2000, 1000, 6]);
    const legend = tables(kinds.blocks)[0];
    expect(legend?.caption).toBe("Legend");
    expect(legend?.rows.map((r) => r[0])).toEqual(["Pin", "Route", "Barrier", "Area", "Label"]);
    expect(legend?.rows.find((r) => r[0] === "Area")?.[3]).toBe("400 sq ft");
    const items = build("site-plan", FIXTURES["site-plan"], {
      legend: "items",
      pins: "1",
      units: "metric",
    });
    const [legendItems, pinTable] = tables(items.blocks);
    expect(legendItems?.rows[0]).toEqual([
      "1",
      "Pin",
      "Main gate",
      "",
      "NWF26-SGN-1 Main entrance arrow",
    ]);
    expect(legendItems?.rows.find((r) => r[2] === "Egress north")?.[3]).toBe("7.62 m");
    expect(pinTable?.caption).toBe("Pins");
    expect(
      tables(build("site-plan", FIXTURES["site-plan"], { legend: "none" }).blocks),
    ).toHaveLength(0);
  });

  it("prints a legacy plan in its 16:10 frame with the note, and never fetches its web image", () => {
    const legacy = {
      ...sitePlan,
      drawing: null,
      calibration: null,
      imageUri: "https://example.test/x.png",
    };
    const model = build("site-plan", {
      ...FIXTURES["site-plan"],
      plan: legacy,
      shapes: [],
      drawing: null,
    });
    const plan = model.blocks.find((b) => b.kind === "plan");
    expect(
      plan && plan.kind === "plan" && [plan.bytes, plan.widthPx, plan.heightPx, plan.note],
    ).toEqual([null, 1600, 1000, "Drawing not stored in XOS"]);
    const drawing = sitePlan.drawing as NonNullable<typeof sitePlan.drawing>;
    const classified = { ...sitePlan, drawing: { ...drawing, unavailable: "classified" as const } };
    const hidden = build(
      "site-plan",
      { ...FIXTURES["site-plan"], plan: classified, drawing: null },
      {},
      "es-US",
    );
    const note = hidden.blocks.find((b) => b.kind === "plan");
    expect(note && note.kind === "plan" && note.note).toContain("Interna");
  });

  it("renders the plan as one Figure with alternative text and the legend as a table with column headers", async () => {
    const model = build("site-plan", FIXTURES["site-plan"], { legend: "items" });
    const pdf = text(await renderDocumentPdf(model, { paper: "letter", orientation: "landscape" }));
    expect(pdf).toContain(
      "/Alt (Site plan Ground floor with 2 pins and 4 shapes drawn on it. The legend lists each one.)",
    );
    const images = (doc: string) => doc.split("/Subtype /Image").length - 1;
    expect(pdf).toContain("/S /Table");
    expect(pdf).toContain("/S /Caption");
    expect(pdf).toContain("/Scope /Column");
    const legacy = build("site-plan", { ...FIXTURES["site-plan"], drawing: null });
    // Without a stored drawing only the brand logo is an image: the drawing is never fetched.
    expect(images(text(await renderDocumentPdf(legacy, { paper: "a4" })))).toBe(images(pdf) - 1);
  }, 60_000);

  it("draws overlays in token colors with at least 3:1 contrast on white", () => {
    const tokens = JSON.parse(
      readFileSync(new URL("../../../tokens/xos.tokens.json", import.meta.url), "utf8"),
    ) as { color: { tokens: { name: string; value: string | Record<string, string> }[] } };
    const light = (name: string) => {
      const v = tokens.color.tokens.find((t) => t.name === name)?.value;
      return typeof v === "string" ? v : v?.["light"];
    };
    expect(PLAN_TONES).toEqual({
      Accent: light("accent-default"),
      Info: light("state-scheduled"),
      Success: light("success-text"),
      Warning: light("warning-text"),
      Danger: light("danger-text"),
      Neutral: light("paper-ink"),
    });
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5]
        .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [
        number,
        number,
        number,
      ];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const color of Object.values(PLAN_TONES))
      expect(1.05 / (luminance(color) + 0.05)).toBeGreaterThanOrEqual(3);
  });
});

describe("signage build sheet", () => {
  it("lists open signs grouped by plan and pin, then words, then unlocated, with a blank Placed column", () => {
    const model = build("signage-build-sheet");
    const [signs] = tables(model.blocks);
    expect(signs?.columns.map((c) => c.label).at(-1)).toBe("Placed (initials)");
    expect(signs?.rows.map((r) => [r[0], r[6], r[8]])).toEqual([
      ["NWF26-SGN-1", "Ground floor, pin 1: Main gate", ""],
      ["NWF26-SGN-2", "Behind the north bar", ""],
      ["NWF26-SGN-3", "No location yet", ""],
    ]);
    const plan = model.blocks.find((b) => b.kind === "plan");
    expect(plan && plan.kind === "plan" && plan.overlays).toEqual([
      { kind: "pin", x: 0.2, y: 0.3, n: 1 },
    ]);
    expect(model.blocks.some((b) => b.kind === "image" && b.maxHeight === 160)).toBe(true);
    expect(DESCRIBE["signage-build-sheet"](FIXTURES["signage-build-sheet"], NOW).orientation).toBe(
      "landscape",
    );
  });

  it("filters by state and prints artwork it cannot embed by its file name", () => {
    const all = build("signage-build-sheet", FIXTURES["signage-build-sheet"], { state: "all" });
    expect(tables(all.blocks)[0]?.rows).toHaveLength(4);
    const placed = build("signage-build-sheet", FIXTURES["signage-build-sheet"], {
      state: "placed",
      units: "metric",
    });
    expect(tables(placed.blocks)[0]?.rows.map((r) => [r[0], r[3]])).toEqual([
      ["NWF26-SGN-4", "61 × 91.4 cm"],
    ]);
    const ordered = build("signage-build-sheet", FIXTURES["signage-build-sheet"], {
      state: "ordered",
    });
    expect(
      ordered.blocks.some(
        (b) => b.kind === "paragraph" && b.text === "Artwork file: menu-board.pdf",
      ),
    ).toBe(true);
  });
});
