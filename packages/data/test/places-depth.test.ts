import { describe, expect, it } from "vitest";
import {
  getPlaceSpec,
  isLegacyPlan,
  listSitePlans,
  listSitePlanShapes,
  listVenueLevels,
  savePlaceSpec,
  saveSitePlanShape,
  setSitePlanDrawing,
  shapePoints,
  SITE_PLAN_MOVES,
  sortPlansByLevel,
  transitionSitePlan,
} from "../src/places.ts";
import { DRAWING_WIDE } from "./documents/fixtures.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const planRow = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  project_id: "pr1",
  venue_id: "v1",
  venue_level_id: null,
  title: "Ground",
  image_uri: "attachments/o/a/v/ground.png",
  plan_state: "Draft",
  drawing_version_id: "d1",
  raster_version_id: null,
  drawing_page: null,
  image_width_px: 2000,
  image_height_px: 1000,
  calibration_ax: "0.1",
  calibration_ay: "0.5",
  calibration_bx: "0.6",
  calibration_by: "0.5",
  calibration_feet: "50",
  deleted_at: null,
  updated_at: "2026-10-01T00:00:00Z",
  drawing: {
    id: "d1",
    filename: "ground.png",
    content_type: "image/png",
    deleted_at: null,
    attachments: { classification: "Internal", deleted_at: null },
  },
  raster: null,
  site_plan_pins: [],
  ...over,
});

/** The fake client with a storage download of the given bytes. */
function withStorage(db: unknown, bytes: Uint8Array) {
  return {
    ...(db as object),
    storage: {
      from: () => ({ download: async () => ({ data: new Blob([bytes.slice()]), error: null }) }),
    },
  } as never;
}

describe("site plan states and drawings (B1)", () => {
  it("reads the state, the stored drawing, its scale and why a raised drawing is hidden", async () => {
    const { db, calls } = fakeClient({
      "from:site_plans": [
        okResponse([
          planRow(),
          planRow({
            id: "p2",
            drawing: {
              ...planRow().drawing,
              attachments: { classification: "Confidential", deleted_at: null },
            },
          }),
          planRow({
            id: "p3",
            drawing: { ...planRow().drawing, deleted_at: "2026-10-02T00:00:00Z" },
          }),
          planRow({
            id: "p4",
            image_uri: "https://example.test/x.png",
            drawing_version_id: null,
            image_width_px: null,
            image_height_px: null,
            calibration_feet: null,
            drawing: null,
          }),
          planRow({
            id: "p5",
            image_uri: "attachments/pending",
            drawing_version_id: null,
            image_width_px: null,
            drawing: null,
          }),
        ]),
      ],
    });
    const plans = await listSitePlans(db, { orgId: "o1", states: ["Draft", "Locked"] });
    expect(calls[0]?.steps).toContainEqual(["in", ["plan_state", ["Draft", "Locked"]]]);
    const [p1, p2, p3, p4, p5] = plans.ok ? plans.data : [];
    expect(p1?.planState).toBe("Draft");
    expect(p1?.calibration).toEqual({ ax: 0.1, ay: 0.5, bx: 0.6, by: 0.5, feet: 50 });
    expect(p1?.drawing).toMatchObject({ shownVersionId: "d1", widthPx: 2000, unavailable: null });
    expect(p2?.drawing?.unavailable).toBe("classified");
    expect(p3?.drawing?.unavailable).toBe("removed");
    expect(p4 && isLegacyPlan(p4)).toBe(true);
    expect(p5?.awaitingDrawing).toBe(true);
    expect(p5 && isLegacyPlan(p5)).toBe(false);
  });

  it("moves a plan with compare-and-set and offers only the D1 graph", async () => {
    const { db, calls } = fakeClient({ "rpc:transition_site_plan": [okResponse("l1")] });
    await transitionSitePlan(db, {
      id: "p1",
      expected: "Draft",
      next: "Locked",
      reason: " Done. ",
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_site_plan_id: "p1", p_expected: "Draft", p_next: "Locked", p_reason: "Done." }],
    ]);
    expect(SITE_PLAN_MOVES.Draft).toEqual(["Locked", "Archived"]);
    expect(SITE_PLAN_MOVES.Archived).toEqual(["Draft"]);
  });

  it("measures the drawing from its bytes before setting it", async () => {
    const { db, calls } = fakeClient({
      "from:attachment_versions": [
        okResponse({ object_name: "o/a/v/ground.png", scan_status: "Clean" }),
      ],
      "from:site_plans": [okResponse([{ id: "p1" }])],
    });
    const result = await setSitePlanDrawing(withStorage(db, DRAWING_WIDE), {
      sitePlanId: "p1",
      drawingVersionId: "d1",
    });
    expect(result.ok).toBe(true);
    expect(calls[1]?.steps[0]).toEqual([
      "update",
      [
        {
          drawing_version_id: "d1",
          raster_version_id: null,
          drawing_page: null,
          image_width_px: 8,
          image_height_px: 4,
        },
      ],
    ]);
  });

  it("refuses an unscanned drawing and a sideways JPEG", async () => {
    const pending = fakeClient({
      "from:attachment_versions": [okResponse({ object_name: "x", scan_status: "Scanning" })],
    });
    const scan = await setSitePlanDrawing(withStorage(pending.db, DRAWING_WIDE), {
      sitePlanId: "p1",
      drawingVersionId: "d1",
    });
    expect(scan.ok === false && scan.error.kind === "refusal" && scan.error.rule).toBe(
      "site_plan_drawing_scan",
    );
    const sideways = Uint8Array.from(
      "ffd8ffe100224578696600004d4d002a00000008000101120003000000010006000000000000ffc0000b080003000501011100ffd9".match(
        /../g,
      ) ?? [],
      (b) => parseInt(b, 16),
    );
    const turned = fakeClient({
      "from:attachment_versions": [okResponse({ object_name: "x", scan_status: "Clean" })],
    });
    const result = await setSitePlanDrawing(withStorage(turned.db, sideways), {
      sitePlanId: "p1",
      drawingVersionId: "d1",
    });
    expect(result.ok === false && result.error.kind === "invalid" && result.error.message).toBe(
      "orientation",
    );
  });
});

describe("levels and shapes (B1)", () => {
  it("lists levels by order then name and sorts plans by level, unleveled last", async () => {
    const { db } = fakeClient({
      "from:venue_levels": [
        okResponse([
          { id: "g", venue_id: "v1", name: "Ground", level_order: 0, deleted_at: null },
          { id: "b", venue_id: "v1", name: "Basement", level_order: -1, deleted_at: null },
          { id: "a", venue_id: "v1", name: "Annex", level_order: 0, deleted_at: null },
        ]),
      ],
    });
    const levels = await listVenueLevels(db, { venueId: "v1" });
    expect(levels.ok && levels.data.map((l) => l.id)).toEqual(["b", "a", "g"]);
    const plan = (id: string, title: string, level: string | null) =>
      ({ id, title, venueLevelId: level }) as never;
    const sorted = sortPlansByLevel(
      [plan("1", "Z", null), plan("2", "B", "g"), plan("3", "A", "g"), plan("4", "C", "b")],
      levels.ok ? levels.data : [],
    );
    expect(sorted.map((p) => p.id)).toEqual(["4", "3", "2", "1"]);
  });

  it("reads shapes from GeoJSON coordinates and draws through the RPC", async () => {
    expect(
      shapePoints("Area", [
        [
          [0.1, 0.2],
          [0.3, 0.2],
          [0.3, 0.6],
          [0.1, 0.2],
        ],
      ]),
    ).toEqual([
      [0.1, 0.2],
      [0.3, 0.2],
      [0.3, 0.6],
    ]);
    expect(shapePoints("Label", [0.5, 0.05])).toEqual([[0.5, 0.05]]);
    const { db, calls } = fakeClient({
      "from:site_plan_shape_geometry": [
        okResponse([
          {
            id: "s1",
            site_plan_id: "p1",
            kind: "Route",
            label: "Egress",
            tone: "Info",
            points_geojson: [
              [0.1, 0.1],
              [0.1, 0.6],
            ],
            length_ft: "25",
            area_sq_ft: null,
          },
        ]),
      ],
      "rpc:save_site_plan_shape": [
        errorResponse("XR001", "site_plan_shape_geometry: bad", "site_plan_shape_geometry"),
      ],
    });
    const shapes = await listSitePlanShapes(db, ["p1"]);
    expect(shapes.ok && shapes.data[0]?.lengthFt).toBe(25);
    expect((await listSitePlanShapes(db, [])).ok).toBe(true);
    const saved = await saveSitePlanShape(db, {
      sitePlanId: "p1",
      kind: "Route",
      label: " Out ",
      points: [
        [0, 0],
        [2, 2],
      ],
    });
    expect(saved.ok === false && saved.error.kind === "refusal" && saved.error.rule).toBe(
      "site_plan_shape_geometry",
    );
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      {
        p_id: null,
        p_site_plan_id: "p1",
        p_kind: "Route",
        p_label: "Out",
        p_tone: null,
        p_points: [
          [0, 0],
          [2, 2],
        ],
      },
    ]);
  });
});

describe("place specs (B1)", () => {
  it("reads a spec with numbers as numbers, or an empty one when none is recorded", async () => {
    const { db } = fakeClient({
      "from:place_specs": [
        okResponse({
          id: "ps1",
          venue_id: "v1",
          space_id: null,
          updated_at: "x",
          house_power_amps: 400,
          rigging_point_load_lb: "2000",
          wifi_available: true,
          dock_notes: "Rear",
        }),
        okResponse(null),
      ],
    });
    const spec = await getPlaceSpec(db, { venueId: "v1" });
    expect(
      spec.ok && [
        spec.data.housePowerAmps,
        spec.data.riggingPointLoadLb,
        spec.data.wifiAvailable,
        spec.data.dockNotes,
        spec.data.clearHeightFt,
      ],
    ).toEqual([400, 2000, true, "Rear", null]);
    const empty = await getPlaceSpec(db, { venueId: "v1", spaceId: "s1" });
    expect(empty.ok && [empty.data.id, empty.data.spaceId]).toEqual([null, "s1"]);
  });

  it("inserts a space's first spec without a venue, which the database derives", async () => {
    const { db, calls } = fakeClient({
      "from:place_specs": [okResponse(null), okResponse([{ id: "ps2" }])],
    });
    const blank = await getPlaceSpec(fakeClient({ "from:place_specs": [okResponse(null)] }).db, {
      venueId: "v1",
      spaceId: "s1",
    });
    if (!blank.ok) throw new Error("no spec");
    await savePlaceSpec(db, { ...blank.data, networkNotes: "  ", internetBandwidthMbps: 500 });
    const insert = calls[1]?.steps[0];
    expect(insert?.[0]).toBe("insert");
    expect(insert?.[1]?.[0]).toMatchObject({
      space_id: "s1",
      network_notes: null,
      internet_bandwidth_mbps: 500,
    });
    expect(insert?.[1]?.[0]).not.toHaveProperty("venue_id");
  });
});
