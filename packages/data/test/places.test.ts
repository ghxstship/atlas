import { describe, expect, it } from "vitest";
import {
  addSitePlanPin,
  callRpc,
  createCapabilityDocument,
  createSitePlan,
  createSpace,
  createVenue,
  createZone,
  documentValidity,
  freezeCapabilityDocument,
  getVenue,
  listCapabilityDocuments,
  listJurisdictions,
  listProjectOptions,
  listSitePlans,
  listSpaces,
  listUridCategories,
  listVenues,
  listZones,
  moveSitePlanPin,
  setPlaceArchived,
  setVenueLocation,
  updateCapabilityDocument,
  updateSitePlan,
  updateSpace,
  updateVenue,
  updateZone,
} from "../src/places.ts";
import { canonClient } from "./canon-client.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const venueRow = {
  id: "v1",
  name: "Northwind Pier Pavilion",
  jurisdiction_id: "US-FL-MIAMI-DADE",
  time_zone: "America/New_York",
  street_address: "1 Pier Way",
  locality: "Miami",
  postal_code: "33101",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
  deleted_at: null,
  latitude: null,
  longitude: null,
  spaces: [{ count: 2 }],
  zones: [{ count: 3 }],
  capability_documents: [],
};

describe("canon pickers", () => {
  it("reads jurisdictions in canon order and marks unpopulated ones", async () => {
    const { db, calls } = canonClient({
      "from:jurisdiction": [
        okResponse([
          { jurisdiction_id: "US", level: "country", parent: null, status: "populated" },
          { jurisdiction_id: "GB", level: "country", parent: null, status: "declared-unpopulated" },
        ]),
      ],
    });
    const result = await listJurisdictions(db);
    expect(result).toEqual({
      ok: true,
      data: [
        { id: "US", level: "country", parent: null, populated: true },
        { id: "GB", level: "country", parent: null, populated: false },
      ],
    });
    expect(calls[0]?.steps).toContainEqual(["order", ["ordinal"]]);
  });

  it("reads URID categories and reports errors", async () => {
    const { db } = canonClient({
      "from:dim_category": [
        okResponse([{ cat_urid: "4000.01.01", category: "Scenic Fabrication" }]),
        errorResponse("PGRST000", "down"),
      ],
    });
    expect(await listUridCategories(db)).toEqual({
      ok: true,
      data: [{ urid: "4000.01.01", name: "Scenic Fabrication" }],
    });
    expect((await listUridCategories(db)).ok).toBe(false);
    const failing = canonClient({ "from:jurisdiction": [errorResponse("PGRST000", "down")] });
    expect((await listJurisdictions(failing.db)).ok).toBe(false);
  });
});

describe("venues", () => {
  it("lists live venues with counts and filters archived ones", async () => {
    const { db, calls } = fakeClient({
      "from:venues": [
        okResponse([venueRow]),
        okResponse([]),
        okResponse([]),
        errorResponse("PGRST000", "x"),
      ],
    });
    const live = await listVenues(db, "o1");
    expect(live.ok && live.data[0]).toMatchObject({
      id: "v1",
      spaceCount: 2,
      zoneCount: 3,
      documentCount: 0,
      latitude: null,
      archivedAt: null,
    });
    expect(calls[0]?.steps).toContainEqual(["is", ["deleted_at", null]]);
    await listVenues(db, "o1", "archived");
    expect(calls[1]?.steps).toContainEqual(["not", ["deleted_at", "is", null]]);
    await listVenues(db, "o1", "all");
    expect(calls[2]?.steps.some(([m]) => m === "is" || m === "not")).toBe(false);
    expect((await listVenues(db, "o1")).ok).toBe(false);
  });

  it("gets one venue or not-found", async () => {
    const { db } = fakeClient({
      "from:venues": [okResponse(venueRow), okResponse(null), errorResponse("42501", "no")],
    });
    expect((await getVenue(db, "v1")).ok).toBe(true);
    expect(await getVenue(db, "v2")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect(await getVenue(db, "v3")).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("creates and updates with trimmed optional fields", async () => {
    const { db, calls } = fakeClient({
      "from:venues": [okResponse([{ id: "v1" }]), okResponse([]), errorResponse("23505", "dup")],
    });
    const input = {
      name: "  Pavilion ",
      jurisdictionId: "US",
      timeZone: "UTC",
      streetAddress: " ",
      locality: " Miami ",
    };
    expect(await createVenue(db, "o1", input)).toEqual({ ok: true, data: { id: "v1" } });
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [
        {
          org_id: "o1",
          name: "Pavilion",
          jurisdiction_id: "US",
          time_zone: "UTC",
          street_address: null,
          locality: "Miami",
          postal_code: null,
        },
      ],
    ]);
    expect(await updateVenue(db, "v1", input)).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await updateVenue(db, "v1", input)).ok).toBe(false);
  });

  it("locates and clears a venue through the RPC", async () => {
    const { db, calls } = fakeClient({
      "rpc:set_venue_location": [
        okResponse("v1"),
        okResponse("v1"),
        errorResponse(
          "XR001",
          "venue_location_range: Longitude runs from -180 to 180.",
          "venue_location_range",
        ),
      ],
    });
    expect(await setVenueLocation(db, "v1", { latitude: 25.76, longitude: -80.19 })).toEqual({
      ok: true,
      data: { id: "v1" },
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_venue_id: "v1", p_longitude: -80.19, p_latitude: 25.76 }],
    ]);
    await setVenueLocation(db, "v1", null);
    expect(calls[1]?.steps[0]).toEqual([
      "args",
      [{ p_venue_id: "v1", p_longitude: null, p_latitude: null }],
    ]);
    const refused = await setVenueLocation(db, "v1", { latitude: 0, longitude: 500 });
    expect(refused.ok === false && refused.error.kind).toBe("refusal");
  });

  it("archives and restores any places row", async () => {
    const at = new Date("2026-10-14T00:00:00Z");
    const { db, calls } = fakeClient({
      "from:zones": [okResponse([{ id: "z1" }]), okResponse([{ id: "z1" }])],
    });
    await setPlaceArchived(db, "zones", "z1", true, at);
    expect(calls[0]?.steps[0]).toEqual(["update", [{ deleted_at: at.toISOString() }]]);
    await setPlaceArchived(db, "zones", "z1", false);
    expect(calls[1]?.steps[0]).toEqual(["update", [{ deleted_at: null }]]);
  });

  it("surfaces an RPC transport failure as unexpected", async () => {
    const { db } = fakeClient({ "rpc:anything": [errorResponse("08006", "connection lost")] });
    expect(await callRpc(db, "anything", {})).toEqual({
      ok: false,
      error: { kind: "unexpected", message: "connection lost", code: "08006" },
    });
  });
});

describe("spaces and zones", () => {
  it("lists spaces and zones with NULL kept as NULL", async () => {
    const { db, calls } = fakeClient({
      "from:spaces": [
        okResponse([
          {
            id: "s1",
            venue_id: "v1",
            urid: null,
            name: "Main Deck",
            area_sq_ft: null,
            capacity: 1200,
            deleted_at: null,
          },
        ]),
        okResponse([]),
        errorResponse("PGRST000", "x"),
      ],
      "from:zones": [
        okResponse([
          {
            id: "z1",
            venue_id: "v1",
            space_id: "s1",
            code: "FOH",
            name: "Front",
            deleted_at: null,
          },
        ]),
        okResponse([]),
        errorResponse("PGRST000", "x"),
      ],
    });
    const spaces = await listSpaces(db, { orgId: "o1", venueId: "v1" });
    expect(spaces.ok && spaces.data[0]).toMatchObject({ areaSqFt: null, capacity: 1200 });
    expect(calls[0]?.steps).toContainEqual(["eq", ["venue_id", "v1"]]);
    await listSpaces(db, { orgId: "o1", archive: "archived" });
    expect((await listSpaces(db, { orgId: "o1" })).ok).toBe(false);
    const zones = await listZones(db, { orgId: "o1", venueId: "v1" });
    expect(zones.ok && zones.data[0]).toMatchObject({ code: "FOH", spaceId: "s1" });
    await listZones(db, { orgId: "o1", archive: "archived" });
    expect((await listZones(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("creates and updates spaces and zones without sending org_id", async () => {
    const { db, calls } = fakeClient({
      "from:spaces": [okResponse([{ id: "s1" }]), okResponse([{ id: "s1" }])],
      "from:zones": [okResponse([{ id: "z1" }]), okResponse([{ id: "z1" }])],
    });
    await createSpace(db, { venueId: "v1", name: " Deck ", capacity: 10 });
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [
        {
          venue_id: "v1",
          name: "Deck",
          urid: null,
          area_sq_ft: null,
          capacity: 10,
          venue_level_id: null,
        },
      ],
    ]);
    await updateSpace(db, "s1", { name: "Deck", urid: "4000.01.01", areaSqFt: 500 });
    await createZone(db, { venueId: "v1", code: " foh ", name: "Front" });
    expect(calls[2]?.steps[0]).toEqual([
      "insert",
      [{ venue_id: "v1", space_id: null, code: "FOH", name: "Front" }],
    ]);
    expect((await updateZone(db, "z1", { code: "bar", name: "Bar", spaceId: "s1" })).ok).toBe(true);
    expect(calls[3]?.steps[0]).toEqual(["update", [{ space_id: "s1", code: "BAR", name: "Bar" }]]);
  });
});

describe("capability documents", () => {
  it("computes validity on a given day", () => {
    const doc = { validFrom: "2027-01-01", validTo: "2027-12-31" };
    expect(documentValidity(doc, "2026-12-31")).toBe("upcoming");
    expect(documentValidity(doc, "2027-06-01")).toBe("valid");
    expect(documentValidity(doc, "2028-01-01")).toBe("stale");
    expect(documentValidity({ validFrom: "2027-01-01", validTo: null }, "2099-01-01")).toBe(
      "valid",
    );
  });

  it("lists, creates, edits and freezes documents", async () => {
    const { db, calls } = fakeClient({
      "from:capability_documents": [
        okResponse([
          {
            id: "d1",
            venue_id: "v1",
            title: "Tech Pack",
            document_uri: "docs/a.pdf",
            valid_from: "2027-01-01",
            valid_to: null,
            is_frozen: true,
            deleted_at: null,
            updated_at: "2026-10-01T00:00:00Z",
          },
        ]),
        okResponse([]),
        errorResponse("PGRST000", "x"),
        okResponse([{ id: "d1" }]),
        errorResponse(
          "XR001",
          "capability_document_frozen: A frozen capability document never changes; add a new version.",
        ),
        okResponse([{ id: "d1" }]),
      ],
    });
    const listed = await listCapabilityDocuments(db, { orgId: "o1", venueId: "v1" });
    expect(listed.ok && listed.data[0]?.frozen).toBe(true);
    await listCapabilityDocuments(db, { orgId: "o1", archive: "archived" });
    expect((await listCapabilityDocuments(db, { orgId: "o1" })).ok).toBe(false);
    await createCapabilityDocument(db, {
      venueId: "v1",
      title: " Tech Pack ",
      documentUri: " docs/a.pdf ",
      validFrom: "2027-01-01",
    });
    expect(calls[3]?.steps[0]).toEqual([
      "insert",
      [
        {
          venue_id: "v1",
          title: "Tech Pack",
          document_uri: "docs/a.pdf",
          valid_from: "2027-01-01",
          valid_to: null,
        },
      ],
    ]);
    const refused = await updateCapabilityDocument(db, "d1", {
      title: "New",
      documentUri: "docs/b.pdf",
      validFrom: "2027-01-01",
    });
    expect(refused).toEqual({
      ok: false,
      error: {
        kind: "refusal",
        rule: "capability_document_frozen",
        message: "A frozen capability document never changes; add a new version.",
      },
    });
    await freezeCapabilityDocument(db, "d1");
    expect(calls[5]?.steps[0]).toEqual(["update", [{ is_frozen: true }]]);
  });
});

describe("site plans", () => {
  it("lists plans with live pins in label order", async () => {
    const { db } = fakeClient({
      "from:site_plans": [
        okResponse([
          {
            id: "p1",
            project_id: "pr1",
            venue_id: "v1",
            title: "Ground Plan",
            image_uri: "plans/ground.png",
            deleted_at: null,
            updated_at: "2026-10-01T00:00:00Z",
            site_plan_pins: [
              {
                id: "b",
                label: "Stage",
                x_ratio: "0.5",
                y_ratio: 0.2,
                zone_id: null,
                record_id: null,
                deleted_at: null,
              },
              {
                id: "a",
                label: "Bar",
                x_ratio: 0.1,
                y_ratio: 0.9,
                zone_id: "z1",
                record_id: null,
                deleted_at: null,
              },
              {
                id: "c",
                label: "Gone",
                x_ratio: 0,
                y_ratio: 0,
                zone_id: null,
                record_id: null,
                deleted_at: "2026-10-02T00:00:00Z",
              },
            ],
          },
        ]),
        okResponse([]),
        errorResponse("PGRST000", "x"),
      ],
    });
    const plans = await listSitePlans(db, { orgId: "o1", projectId: "pr1" });
    expect(plans.ok && plans.data[0]?.pins.map((p) => [p.label, p.x])).toEqual([
      ["Bar", 0.1],
      ["Stage", 0.5],
    ]);
    await listSitePlans(db, { orgId: "o1", archive: "archived" });
    expect((await listSitePlans(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("creates, edits and pins", async () => {
    const { db, calls } = fakeClient({
      "from:site_plans": [okResponse([{ id: "p1" }]), okResponse([{ id: "p1" }])],
      "from:site_plan_pins": [
        okResponse([{ id: "n1" }]),
        errorResponse("23514", "site_plan_pins_position"),
      ],
    });
    await createSitePlan(db, { projectId: "pr1", title: " Ground ", imageUri: " a.png " });
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [
        {
          project_id: "pr1",
          venue_id: null,
          venue_level_id: null,
          title: "Ground",
          image_uri: "a.png",
        },
      ],
    ]);
    await updateSitePlan(db, "p1", { title: "G", imageUri: "b.png", venueId: "v1" });
    await addSitePlanPin(db, { sitePlanId: "p1", label: " Stage ", x: 0.5, y: 0.5 });
    expect(calls[2]?.steps[0]).toEqual([
      "insert",
      [{ site_plan_id: "p1", label: "Stage", x_ratio: 0.5, y_ratio: 0.5, zone_id: null }],
    ]);
    const moved = await moveSitePlanPin(db, "n1", { x: 2, y: 0 });
    expect(moved.ok === false && moved.error.kind).toBe("invalid");
  });

  it("lists project options for pickers", async () => {
    const { db } = fakeClient({
      "from:projects": [
        okResponse([
          {
            id: "pr1",
            project_key: "NWL",
            name: "Summer",
            jurisdiction_id: null,
            venue_id: null,
          },
        ]),
        errorResponse("PGRST000", "x"),
      ],
    });
    expect(await listProjectOptions(db, "o1")).toEqual({
      ok: true,
      data: [{ id: "pr1", key: "NWL", name: "Summer", jurisdictionId: null, venueId: null }],
    });
    expect((await listProjectOptions(db, "o1")).ok).toBe(false);
  });
});
