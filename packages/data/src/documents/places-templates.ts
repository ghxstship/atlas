import { feetToMeters, sqFtToSqM } from "../places-geometry.ts";
import type { SitePlan, SitePlanShape, SitePlanShapeKind } from "../places.ts";
import type { Sign, SignProductionState } from "../signage.ts";
import type { Formatter, Translate } from "./format.ts";
import type { DocumentBlock, PlanOverlay } from "./model.ts";
import type { DocumentProject, TemplateContext, TemplateOutput } from "./templates.ts";

/**
 * The site plan export and the signage build sheet (B1, G-19 and G-24; ADR 0031 amendment B1, ADR 0140). Both are
 * computed from live records when they are generated, so their issue time is the generation time, as for the final
 * cost report. Their options come from the request's search params and are parsed here, falling back to the defaults
 * for any value they do not know. Self-contained: templates.ts imports these builders, and this module imports only
 * types from it.
 */

export type PlanLayer = "pins" | "routes" | "barriers" | "areas" | "labels";
export const PLAN_LAYERS: readonly PlanLayer[] = ["pins", "routes", "barriers", "areas", "labels"];
export type PlanLegend = "kinds" | "items" | "none";
export type Units = "imperial" | "metric";

export interface SitePlanExportOptions {
  readonly layers: ReadonlySet<PlanLayer>;
  readonly legend: PlanLegend;
  readonly pinTable: boolean;
  readonly units: Units;
}

type Params = Readonly<Record<string, string | undefined>>;

const unitsOf = (params: Params): Units => (params["units"] === "metric" ? "metric" : "imperial");

/** ?layers=pins,routes,barriers,areas,labels&legend=kinds|items|none&pins=0|1; unknown values take the defaults. */
export function parseSitePlanExportOptions(params: Params): SitePlanExportOptions {
  const asked = (params["layers"] ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter((l): l is PlanLayer => (PLAN_LAYERS as readonly string[]).includes(l));
  const legend = params["legend"];
  return {
    layers: new Set(asked.length > 0 ? asked : PLAN_LAYERS),
    legend: legend === "items" || legend === "none" ? legend : "kinds",
    pinTable: params["pins"] === "1",
    units: unitsOf(params),
  };
}

export type BuildSheetFilter = "to-order" | "ordered" | "printed" | "placed" | "all" | "open";

/** ?state=to-order|ordered|printed|placed|all; the default is every sign not yet Placed. */
export function parseBuildSheetOptions(params: Params): {
  readonly state: BuildSheetFilter;
  readonly units: Units;
} {
  const state = params["state"];
  const known: readonly string[] = ["to-order", "ordered", "printed", "placed", "all"];
  return {
    state: state && known.includes(state) ? (state as BuildSheetFilter) : "open",
    units: unitsOf(params),
  };
}

const STATE_OF: Readonly<Record<Exclude<BuildSheetFilter, "all" | "open">, SignProductionState>> = {
  "to-order": "To Order",
  ordered: "Ordered",
  printed: "Printed",
  placed: "Placed",
};

export function signsForSheet(signs: readonly Sign[], state: BuildSheetFilter): Sign[] {
  if (state === "all") return [...signs];
  if (state === "open") return signs.filter((s) => s.state !== "Placed");
  return signs.filter((s) => s.state === STATE_OF[state]);
}

// Site plan ------------------------------------------------------------------------------------------------

export interface SitePlanDocumentData {
  readonly project: DocumentProject;
  readonly plan: SitePlan;
  readonly venueName: string | null;
  readonly levelName: string | null;
  readonly shapes: readonly SitePlanShape[];
  /** PNG or JPEG bytes of the drawing as shown, read as the caller; null when not stored or no longer drawable. */
  readonly drawing: Uint8Array | null;
  /** The keys and titles of the live signs at each pin, by pin id. */
  readonly signsAtPins: Readonly<Record<string, readonly string[]>>;
}

/** A length or area in the reader's units: feet and square feet, or meters and square meters. */
export function measure(
  f: Formatter,
  t: Translate,
  units: Units,
  feet: number | null,
  area = false,
): string {
  if (feet === null) return t("common.none");
  const value = units === "metric" ? (area ? sqFtToSqM(feet) : feetToMeters(feet)) : feet;
  const rounded = new Intl.NumberFormat(f.locale, { maximumFractionDigits: 2 }).format(value);
  return t(`sitePlan.units.${units}.${area ? "area" : "length"}`, { value: rounded });
}

const LAYER_OF: Readonly<Record<SitePlanShapeKind, PlanLayer>> = {
  Route: "routes",
  Barrier: "barriers",
  Area: "areas",
  Label: "labels",
};

/** Pins numbered 1 to n in label order, then shapes numbered after them, as the Atlas legend numbers them. */
export function numberPlanItems(plan: Pick<SitePlan, "pins">, shapes: readonly SitePlanShape[]) {
  const pins = plan.pins.map((pin, i) => ({ pin, n: i + 1 }));
  const numbered = shapes.map((shape, i) => ({ shape, n: plan.pins.length + i + 1 }));
  return { pins, shapes: numbered };
}

export function planOverlays(
  plan: Pick<SitePlan, "pins">,
  shapes: readonly SitePlanShape[],
  layers: ReadonlySet<PlanLayer>,
): PlanOverlay[] {
  const items = numberPlanItems(plan, shapes);
  const out: PlanOverlay[] = [];
  for (const { shape, n } of items.shapes) {
    if (!layers.has(LAYER_OF[shape.kind])) continue;
    if (shape.kind === "Label") {
      const at = shape.points[0];
      if (at) out.push({ kind: "label", x: at[0], y: at[1], text: shape.label });
    } else {
      out.push({
        kind: shape.kind === "Route" ? "route" : shape.kind === "Barrier" ? "barrier" : "area",
        points: shape.points,
        tone: shape.tone,
        n,
      });
    }
  }
  if (layers.has("pins"))
    for (const { pin, n } of items.pins) out.push({ kind: "pin", x: pin.x, y: pin.y, n });
  return out;
}

/** The plan block, with the ruled frame and its note when the drawing is not stored or not drawable (ADR 0140 D3). */
function planBlock(
  t: Translate,
  plan: SitePlan,
  drawing: Uint8Array | null,
  overlays: readonly PlanOverlay[],
  alt: string,
): DocumentBlock {
  // A legacy plan's pins were placed on the old 16:10 frame, so it prints in that frame (C13).
  const sized = drawing && plan.drawing ? plan.drawing : { widthPx: 1600, heightPx: 1000 };
  const note =
    plan.drawing?.unavailable === "classified"
      ? t("sitePlan.drawingClassified")
      : plan.drawing?.unavailable === "removed"
        ? t("sitePlan.drawingRemoved")
        : t("sitePlan.drawingNotStored");
  return {
    kind: "plan",
    bytes: drawing,
    widthPx: sized.widthPx,
    heightPx: sized.heightPx,
    alt,
    overlays,
    note,
  };
}

export function buildSitePlan(d: SitePlanDocumentData, ctx: TemplateContext): TemplateOutput {
  const { t, f } = ctx;
  const options = parseSitePlanExportOptions(ctx.options);
  const { plan, shapes } = d;
  const items = numberPlanItems(plan, shapes);
  const overlays = planOverlays(plan, shapes, options.layers);
  const scale = plan.calibration
    ? t("sitePlan.scaleValue", { distance: measure(f, t, options.units, plan.calibration.feet) })
    : t("sitePlan.notCalibrated");
  const blocks: DocumentBlock[] = [
    {
      kind: "fields",
      caption: t("common.details"),
      fields: [
        {
          label: t("common.project"),
          value: [d.project.key, d.project.name].filter(Boolean).join(" "),
        },
        { label: t("sitePlan.venue"), value: d.venueName ?? t("common.none") },
        { label: t("sitePlan.level"), value: d.levelName ?? t("common.none") },
        { label: t("common.state"), value: t(`sitePlan.states.${plan.planState}`) },
        { label: t("sitePlan.scale"), value: scale },
      ],
    },
    planBlock(
      t,
      plan,
      d.drawing,
      overlays,
      t("sitePlan.alt", { title: plan.title, pins: plan.pins.length, shapes: shapes.length }),
    ),
  ];
  if (options.legend === "kinds") {
    const kinds: SitePlanShapeKind[] = ["Route", "Barrier", "Area", "Label"];
    const rows: string[][] = [];
    if (plan.pins.length > 0)
      rows.push([t("sitePlan.kinds.Pin"), f.number(plan.pins.length), "", ""]);
    for (const kind of kinds) {
      const of = shapes.filter((s) => s.kind === kind);
      if (of.length === 0) continue;
      const total = (pick: (s: SitePlanShape) => number | null) =>
        of.some((s) => pick(s) === null) ? null : of.reduce((n, s) => n + (pick(s) ?? 0), 0);
      rows.push([
        t(`sitePlan.kinds.${kind}`),
        f.number(of.length),
        kind === "Label"
          ? ""
          : measure(
              f,
              t,
              options.units,
              total((s) => s.lengthFt),
            ),
        kind === "Area"
          ? measure(
              f,
              t,
              options.units,
              total((s) => s.areaSqFt),
              true,
            )
          : "",
      ]);
    }
    blocks.push({
      kind: "table",
      caption: t("sitePlan.legend"),
      columns: [
        { label: t("sitePlan.kind"), weight: 2 },
        { label: t("sitePlan.count"), numeric: true },
        { label: t("sitePlan.length"), numeric: true, weight: 1.5 },
        { label: t("sitePlan.area"), numeric: true, weight: 1.5 },
      ],
      rows,
      empty: t("sitePlan.emptyLegend"),
    });
  } else if (options.legend === "items") {
    const rows: string[][] = [
      ...items.pins.map(({ pin, n }) => [
        String(n),
        t("sitePlan.kinds.Pin"),
        pin.label,
        "",
        (d.signsAtPins[pin.id] ?? []).join(", "),
      ]),
      ...items.shapes.map(({ shape, n }) => [
        String(n),
        t(`sitePlan.kinds.${shape.kind}`),
        shape.label,
        shape.kind === "Area"
          ? measure(f, t, options.units, shape.areaSqFt, true)
          : shape.kind === "Label"
            ? ""
            : measure(f, t, options.units, shape.lengthFt),
        "",
      ]),
    ];
    blocks.push({
      kind: "table",
      caption: t("sitePlan.legend"),
      columns: [
        { label: t("sitePlan.number"), numeric: true, weight: 0.5 },
        { label: t("sitePlan.kind") },
        { label: t("sitePlan.label"), weight: 2.5 },
        { label: t("sitePlan.measure"), numeric: true, weight: 1.4 },
        { label: t("sitePlan.signs"), weight: 2 },
      ],
      rows,
      empty: t("sitePlan.emptyLegend"),
    });
  }
  if (options.pinTable) {
    blocks.push({
      kind: "table",
      caption: t("sitePlan.pinTable"),
      columns: [
        { label: t("sitePlan.number"), numeric: true, weight: 0.5 },
        { label: t("sitePlan.label"), weight: 2.5 },
        { label: t("sitePlan.across"), numeric: true },
        { label: t("sitePlan.down"), numeric: true },
      ],
      rows: items.pins.map(({ pin, n }) => [
        String(n),
        pin.label,
        f.number(Math.round(pin.x * 1000) / 10),
        f.number(Math.round(pin.y * 1000) / 10),
      ]),
      empty: t("sitePlan.noPins"),
    });
  }
  return { title: t("sitePlan.title", { title: plan.title }), blocks };
}

// Signage build sheet --------------------------------------------------------------------------------------

export interface BuildSheetPlan {
  readonly plan: SitePlan;
  readonly drawing: Uint8Array | null;
}

export interface BuildSheetData {
  readonly project: DocumentProject;
  readonly signs: readonly Sign[];
  /** The live plans of the project that hold a sign's pin. */
  readonly plans: readonly BuildSheetPlan[];
  /** Embeddable artwork bytes (Clean PNG or JPEG, at most 2 MiB, Public or Internal) or the file name, by sign id. */
  readonly artwork: Readonly<
    Record<string, { readonly bytes: Uint8Array | null; readonly filename: string }>
  >;
}

const size = (f: Formatter, t: Translate, units: Units, sign: Sign) => {
  if (sign.widthIn === null || sign.heightIn === null) return t("common.none");
  const fmt = (inches: number) =>
    new Intl.NumberFormat(f.locale, { maximumFractionDigits: 1 }).format(
      units === "metric" ? inches * 2.54 : inches,
    );
  return t(`buildSheet.size.${units}`, { width: fmt(sign.widthIn), height: fmt(sign.heightIn) });
};

export function buildSignageSheet(d: BuildSheetData, ctx: TemplateContext): TemplateOutput {
  const { t, f } = ctx;
  const options = parseBuildSheetOptions(ctx.options);
  const signs = signsForSheet(d.signs, options.state);
  const pinPlace = new Map<string, { plan: SitePlan; n: number; label: string }>();
  const figures: DocumentBlock[] = [];
  for (const { plan, drawing } of d.plans) {
    const held = new Set(
      signs.map((s) => s.sitePlanPinId).filter((id): id is string => id !== null),
    );
    const pins = plan.pins.filter((p) => held.has(p.id));
    if (pins.length === 0) continue;
    pins.forEach((pin, i) => pinPlace.set(pin.id, { plan, n: i + 1, label: pin.label }));
    figures.push({ kind: "heading", text: plan.title });
    figures.push(
      planBlock(
        t,
        plan,
        drawing,
        pins.map((pin, i) => ({ kind: "pin", x: pin.x, y: pin.y, n: i + 1 })),
        t("buildSheet.planAlt", { title: plan.title, pins: pins.length }),
      ),
    );
  }
  const group = (s: Sign) => {
    const at = s.sitePlanPinId ? pinPlace.get(s.sitePlanPinId) : undefined;
    if (at) return [0, at.plan.title, at.n] as const;
    if (s.locationText) return [1, s.locationText, 0] as const;
    return [2, "", 0] as const;
  };
  const ordered = [...signs].sort((a, b) => {
    const [ga, ka, na] = group(a);
    const [gb, kb, nb] = group(b);
    return ga - gb || ka.localeCompare(kb) || na - nb || a.number - b.number;
  });
  const location = (s: Sign) => {
    const at = s.sitePlanPinId ? pinPlace.get(s.sitePlanPinId) : undefined;
    if (at) return t("buildSheet.atPin", { plan: at.plan.title, n: at.n, label: at.label });
    return s.locationText ?? t("buildSheet.unlocated");
  };
  const stateKey = (s: Sign) => s.state.replace(/\s/g, "");
  const blocks: DocumentBlock[] = [
    {
      kind: "fields",
      caption: t("common.details"),
      fields: [
        {
          label: t("common.project"),
          value: [d.project.key, d.project.name].filter(Boolean).join(" "),
        },
        { label: t("buildSheet.showing"), value: t(`buildSheet.filters.${options.state}`) },
        { label: t("buildSheet.count"), value: f.number(ordered.length) },
      ],
    },
    {
      kind: "table",
      caption: t("buildSheet.signs"),
      columns: [
        { label: t("buildSheet.key"), weight: 1.3 },
        { label: t("buildSheet.signTitle"), weight: 2.2 },
        { label: t("buildSheet.type"), weight: 1.2 },
        { label: t("buildSheet.sizeLabel"), weight: 1.2 },
        { label: t("buildSheet.quantity"), numeric: true, weight: 0.7 },
        { label: t("buildSheet.substrate"), weight: 1.2 },
        { label: t("buildSheet.location"), weight: 2.2 },
        { label: t("buildSheet.state"), weight: 1 },
        { label: t("buildSheet.placedInitials"), weight: 1.1 },
      ],
      rows: ordered.map((s) => [
        s.key,
        s.title,
        t(`buildSheet.types.${s.type}`),
        size(f, t, options.units, s),
        f.number(s.quantity),
        s.substrate ?? "",
        location(s),
        t(`buildSheet.states.${stateKey(s)}`),
        "",
      ]),
      empty: t("buildSheet.noSigns"),
    },
    ...figures,
  ];
  const withArtwork = ordered.filter((s) => d.artwork[s.id]);
  if (withArtwork.length > 0) {
    blocks.push({ kind: "heading", text: t("buildSheet.artwork") });
    for (const s of withArtwork) {
      const art = d.artwork[s.id];
      if (!art) continue;
      blocks.push({
        kind: "paragraph",
        text: t("buildSheet.artworkFor", { key: s.key, title: s.title }),
      });
      blocks.push(
        art.bytes
          ? {
              kind: "image",
              bytes: art.bytes,
              alt: t("buildSheet.artworkAlt", { key: s.key, title: s.title }),
              maxHeight: 160,
            }
          : { kind: "paragraph", text: t("buildSheet.artworkFile", { name: art.filename }) },
      );
    }
  }
  return { title: t("buildSheet.title", { project: d.project.key || d.project.name }), blocks };
}
