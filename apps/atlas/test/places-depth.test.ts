/**
 * B1 places depth (RRR-225, ADR 0140): the plan export link, the Inbox targets of plans, pins, shapes and signs, the
 * catalog copy of every new refusal in both locales, measurements in the viewer's units, and the sign form, which
 * shows the purchase order line only to a procurement reader. Rendered with the real components and catalog.
 */
import { getMessages } from "@xos/i18n";
import type { SitePlan } from "@xos/data/places";
import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { sitePlanExportHref } from "@/components/places/plans/plan-export-panel";
import { PlanTools } from "@/components/places/plans/plan-tools";
import { formatArea, formatLength } from "@/components/places/plans/plan-units";
import { SignForm } from "@/components/places/signage/sign-form";
import { inboxTarget } from "@/lib/inbox/describe";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/demo-productions/places/signage",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/app/[org]/places/signage/actions", () => ({ saveSignAction: async () => ({}) }));
vi.mock("@/app/[org]/places/plan-actions", () => ({
  postPointNoteAction: async () => ({}),
  saveShapeAction: async () => ({}),
  setCalibrationAction: async () => ({}),
}));
vi.mock("@/app/[org]/places/actions", () => ({ addPinAction: async () => ({}) }));
vi.mock("@/components/custom-fields/inputs", () => ({ CustomFieldInputs: () => null }));

const flatten = (value: unknown, prefix = "", out = new Map<string, string>()) => {
  if (typeof value === "string") out.set(prefix, value);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
};

describe("site plan export link (ADR 0031 amendment B1)", () => {
  const base = "/demo/documents/site-plan/p1";
  it("sends only the choices that differ from the defaults", () => {
    const all = ["pins", "routes", "barriers", "areas", "labels"] as const;
    expect(
      sitePlanExportHref(base, { paper: "letter", layers: all, legend: "kinds", pins: false }),
    ).toBe(base);
    expect(
      sitePlanExportHref(base, {
        paper: "a4",
        layers: ["pins", "areas"],
        legend: "items",
        pins: true,
      }),
    ).toBe(`${base}?paper=a4&layers=pins%2Careas&legend=items&pins=1`);
  });
});

describe("Inbox targets of B1 subjects", () => {
  it("opens the plan, the pin's or shape's thread, and the sign", () => {
    const at = (subjectTable: string) =>
      inboxTarget("demo", { subjectTable, subjectId: "x1", kind: "mention.created" });
    expect(at("app.site_plans")).toBe("/demo/places/site-plans?peek=x1");
    expect(at("app.site_plan_pins")).toBe("/demo/places/site-plans?pin=x1");
    expect(at("app.site_plan_shapes")).toBe("/demo/places/site-plans?shape=x1");
    expect(at("app.signs")).toBe("/demo/places/signage?peek=x1");
  });
});

describe("refusal copy", () => {
  it("has a sentence for every B1 refusal in en-US and es-US", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../components/places/kit/action-state.ts", import.meta.url), "utf8"),
    );
    const block = source.slice(
      source.indexOf("// B1 site plans"),
      source.indexOf("]);", source.indexOf("// B1 site plans")),
    );
    const codes = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
    expect(codes.length).toBeGreaterThan(30);
    for (const locale of ["en-US", "es-US"] as const) {
      const catalog = flatten(getMessages(locale));
      expect(
        codes.filter((c) => !catalog.get(`places.errors.${c}`)),
        locale,
      ).toEqual([]);
    }
  });
});

describe("measurements in the viewer's units", () => {
  it("shows feet or meters at 0.3048, as acceptance 7 reads them", () => {
    expect(formatLength(25, "imperial", "en-US")).toBe("25 ft");
    expect(formatLength(25, "metric", "en-US")).toBe("7.62 m");
    expect(formatArea(400, "metric", "en-US")).toBe("37.16 m²");
    expect(formatArea(400, "imperial", "es-US")).toBe("400 ft²");
  });
});

describe("sign form", () => {
  const plans = [
    {
      id: "p1",
      title: "Ground",
      projectId: "pr1",
      draft: true,
      pins: [{ id: "pin1", label: "Gate" }],
    },
  ];
  const render = (poLines: Parameters<typeof SignForm>[0]["poLines"]) =>
    renderToStaticMarkup(
      createElement(
        NextIntlClientProvider,
        { locale: "en-US", messages: getMessages("en-US") } as never,
        createElement(SignForm, {
          org: "demo",
          projects: [{ id: "pr1", label: "NWL Northwind" }],
          plans,
          vendors: [{ id: "v1", name: "Harbor Print" }],
          poLines,
          units: "metric",
        }),
      ),
    );

  it("shows no order line to a reader without procurement read, and sizes in the viewer's units", () => {
    const html = render(null);
    expect(html).not.toContain("Purchase order line");
    expect(html).toContain("Width (cm)");
    expect(html).toContain("Printer");
  });

  it("offers a procurement reader the project's order lines", () => {
    const html = render([
      {
        id: "l1",
        purchaseOrderId: "po1",
        poNumber: "NWL-PO-1",
        lineNumber: 1,
        description: "Arrows",
        vendorName: "Harbor Print",
      },
    ]);
    expect(html).toContain("Purchase order line");
    expect(html).toContain("NWL-PO-1 line 1: Arrows");
  });
});

describe("plan tools (ADR 0140 D4)", () => {
  const plan: SitePlan = {
    id: "p1",
    projectId: "pr1",
    venueId: null,
    venueLevelId: null,
    title: "Ground",
    imageUri: "attachments/o/a/v/g.png",
    planState: "Draft",
    awaitingDrawing: false,
    drawing: {
      versionId: "v1",
      rasterVersionId: null,
      page: null,
      contentType: "image/png",
      filename: "g.png",
      shownVersionId: "v1",
      widthPx: 2000,
      heightPx: 1000,
      unavailable: null,
    },
    calibration: { ax: 0.1, ay: 0.5, bx: 0.6, by: 0.5, feet: 50 },
    archivedAt: null,
    updatedAt: "2026-10-01T00:00:00Z",
    pins: [],
  };
  const render = (props: Partial<Parameters<typeof PlanTools>[0]>) =>
    renderToStaticMarkup(
      createElement(
        NextIntlClientProvider,
        { locale: "en-US", messages: getMessages("en-US") } as never,
        createElement(PlanTools, {
          org: "demo",
          plan,
          zones: [],
          units: "imperial",
          editable: true,
          canComment: true,
          tool: "measure",
          setTool: () => undefined,
          points: [
            [0.1, 0.1],
            [0.1, 0.6],
          ],
          setPoints: () => undefined,
          selected: null,
          setSelected: () => undefined,
          ...props,
        }),
      ),
    );

  it("announces a measured length and gives every point Across and Down fields", () => {
    const html = render({});
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Length: 25 ft");
    expect(html).toContain("Point 1 across (%)");
    expect(html).toContain("Point 2 down (%)");
    expect(render({ units: "metric" })).toContain("Length: 7.62 m");
  });

  it("asks for the scale on an uncalibrated plan, and offers only Annotate where the layout is fixed", () => {
    expect(render({ plan: { ...plan, calibration: null } })).toContain("Set the scale to measure");
    const locked = render({ editable: false, tool: "select" });
    expect(locked).toContain("Annotate");
    expect(locked).not.toContain(">Barrier<");
  });
});
