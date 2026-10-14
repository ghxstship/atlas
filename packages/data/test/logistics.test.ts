import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client";
import {
  addMarshallingEntry,
  addShipmentLine,
  bookDockSlot,
  cancelDockSlot,
  checkInDockSlot,
  createShipment,
  deleteShipment,
  displayKey,
  findIdByKey,
  findOperationsProject,
  getOperationsAccess,
  getShipment,
  instantToLocal,
  listCounterpartyOptions,
  listDockSlots,
  listFreightTypes,
  listGateQueue,
  listMarshallingLog,
  listOperationsProjects,
  listShipments,
  listZoneOptions,
  localToInstant,
  parseDisplayKey,
  recordGateArrival,
  releaseVehicle,
  removeGateEntry,
  removeShipmentLine,
  restoreDockSlot,
  restoreShipment,
  shipmentProgress,
  updateDockSlot,
  updateShipment,
  type ShipmentInput,
} from "../src/logistics";
import { errorResponse, fakeClient, okResponse, type Response } from "./fake-client";

/** The shared fake client plus `schema()`, which canon reads switch to. */
function client(queues: Record<string, Response[]>) {
  const fake = fakeClient(queues);
  const db = Object.assign(Object.create(fake.db as object), {
    schema: () => fake.db,
  }) as XosClient;
  return { db, calls: fake.calls };
}

const project = {
  project_key: "NWL",
  name: "Northwind Summer Series",
  time_zone: "America/New_York",
};
const shipmentRow = {
  id: "s1",
  shipment_number: 12,
  project_id: "p1",
  direction: "Inbound",
  carrier_counterparty_id: "c1",
  freight_type_enum_id: "ENM-022",
  tracking_identifier: "1Z999",
  ships_at: "2027-05-30T12:00:00Z",
  arrives_at: "2027-06-01T10:00:00Z",
  created_at: "2027-05-01T00:00:00Z",
  updated_at: "2027-05-02T00:00:00Z",
  project,
  carrier: { counterparty_name: "Bayside Freight" },
  dock_slots: [{ deleted_at: null, checked_in_at: null }],
  gate_queue: [],
  shipment_lines: [{ deleted_at: null }, { deleted_at: "2027-05-03T00:00:00Z" }],
};
const slotRow = {
  id: "d1",
  project_id: "p1",
  zone_id: "z1",
  shipment_id: "s1",
  engagement_id: null,
  starts_at: "2027-06-01T10:00:00Z",
  ends_at: "2027-06-01T12:00:00Z",
  checked_in_at: null,
  project,
  zone: { code: "DOCK-1", name: "Loading Dock" },
  checker: null,
};
const gateRow = {
  id: "g1",
  project_id: "p1",
  shipment_id: "s1",
  vehicle_identifier: "FL-TRK-221",
  arrived_at: "2027-06-01T09:40:00Z",
  released_at: null,
  project,
  releaser: null,
};
const logRow = {
  id: "l1",
  project_id: "p1",
  shipment_id: "s1",
  zone_id: null,
  entry: "Staged in lane 2.",
  logged_at: "2027-06-01T09:45:00Z",
  project,
  zone: null,
  author: { full_name: "Dana Reyes" },
};
const input: ShipmentInput = {
  direction: "Inbound",
  carrierId: null,
  freightTypeId: "ENM-022",
  trackingIdentifier: null,
  shipsAt: null,
  arrivesAt: "2027-06-01T10:00:00Z",
};

describe("shipment progress", () => {
  it("derives each stage from slots and gate entries", () => {
    expect(shipmentProgress([], [])).toBe("logged");
    expect(shipmentProgress([{ deleted_at: "x", checked_in_at: null }], [])).toBe("logged");
    expect(shipmentProgress([{ deleted_at: null, checked_in_at: null }], [])).toBe("booked");
    expect(
      shipmentProgress(
        [{ deleted_at: null, checked_in_at: null }],
        [{ deleted_at: null, released_at: null }],
      ),
    ).toBe("at-gate");
    expect(
      shipmentProgress(
        [{ deleted_at: null, checked_in_at: "t" }],
        [{ deleted_at: null, released_at: null }],
      ),
    ).toBe("checked-in");
    expect(shipmentProgress([], [{ deleted_at: null, released_at: "t" }])).toBe("released");
    expect(shipmentProgress([], [{ deleted_at: "x", released_at: "t" }])).toBe("logged");
  });
});

describe("display keys", () => {
  it("formats and parses {projectKey}-{number}", () => {
    expect(displayKey("NWL", 12)).toBe("NWL-12");
    expect(parseDisplayKey("NWL-12")).toEqual({ projectKey: "NWL", number: 12 });
    expect(parseDisplayKey("nwl-12")).toBeNull();
    expect(parseDisplayKey("NWL-0")).toBeNull();
    expect(parseDisplayKey("NWL")).toBeNull();
  });

  it("finds a row by key within the org's project", async () => {
    const { db, calls } = client({
      "from:projects": [okResponse({ id: "p1", ...project, venue_id: null })],
      "from:beos": [okResponse({ id: "b1" })],
    });
    expect(await findIdByKey(db, "o1", "beos", "NWL-7")).toEqual({ ok: true, data: "b1" });
    expect(calls[1]?.steps).toContainEqual(["eq", ["beo_number", 7]]);
  });

  it("answers not-found for a malformed key, a missing project or a missing row", async () => {
    const { db } = client({
      "from:projects": [okResponse(null), okResponse({ id: "p1", ...project, venue_id: null })],
      "from:shipments": [okResponse(null), errorResponse("XX000", "boom")],
    });
    expect(await findIdByKey(db, "o1", "shipments", "bad")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await findIdByKey(db, "o1", "shipments", "NWL-1")).ok).toBe(false);
    const project2 = client({
      "from:projects": [okResponse({ id: "p1", ...project, venue_id: null })],
      "from:shipments": [okResponse(null)],
    });
    expect(await findIdByKey(project2.db, "o1", "shipments", "NWL-1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });
});

describe("time zones", () => {
  it("reads a wall-clock time in the project zone as an instant", () => {
    expect(localToInstant("2027-06-01T08:00", "America/New_York")).toBe("2027-06-01T12:00:00.000Z");
    expect(localToInstant("2027-01-15T08:00", "America/New_York")).toBe("2027-01-15T13:00:00.000Z");
    expect(localToInstant("2027-02-30T08:00", "UTC")).toBeNull();
    expect(localToInstant("tomorrow", "UTC")).toBeNull();
  });

  it("shows an instant as wall-clock time in a zone", () => {
    expect(instantToLocal("2027-06-01T12:00:00Z", "America/New_York")).toBe("2027-06-01T08:00");
    expect(instantToLocal("2027-06-01T12:00:00Z", "Europe/Madrid")).toBe("2027-06-01T14:00");
  });
});

describe("lookups", () => {
  it("lists and finds projects", async () => {
    const row = { id: "p1", ...project, venue_id: "v1" };
    const { db } = client({
      "from:projects": [okResponse([row]), okResponse(row), errorResponse("XX000", "down")],
    });
    const list = await listOperationsProjects(db, "o1");
    expect(list.ok && list.data[0]).toEqual({
      id: "p1",
      key: "NWL",
      name: "Northwind Summer Series",
      timeZone: "America/New_York",
      venueId: "v1",
    });
    expect((await findOperationsProject(db, "o1", "NWL")).ok).toBe(true);
    expect(await findOperationsProject(db, "o1", "NWL")).toEqual({
      ok: false,
      error: { kind: "unexpected", message: "down", code: "XX000" },
    });
  });

  it("names counterparties from their one home and sorts them", async () => {
    const { db } = client({
      "from:counterparties": [
        okResponse([
          { id: "c2", counterparty_type: null, counterparty_name: "Zephyr Freight" },
          { id: "c1", counterparty_type: null, counterparty_name: "Bayside Freight" },
          { id: "c3", counterparty_type: null, counterparty_name: null },
        ]),
      ],
    });
    const result = await listCounterpartyOptions(db, "o1");
    expect(result.ok && result.data.map((c) => c.id)).toEqual(["c3", "c1", "c2"]);
  });

  it("reads canon freight types in canon order", async () => {
    const { db, calls } = client({
      "from:std_enumeration": [
        okResponse([{ record_id: "ENM-020", enum_code: "FRT_LTL", enum_label: "LTL Freight" }]),
      ],
    });
    const result = await listFreightTypes(db);
    expect(result.ok && result.data).toEqual([
      { id: "ENM-020", code: "FRT_LTL", label: "LTL Freight" },
    ]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["enum_domain", "Freight Type"]]);
  });

  it("lists zones of venues, and none without venues", async () => {
    const { db } = client({
      "from:zones": [okResponse([{ id: "z1", code: "DOCK-1", name: "Dock", venue_id: "v1" }])],
    });
    expect(await listZoneOptions(db, [])).toEqual({ ok: true, data: [] });
    const result = await listZoneOptions(db, ["v1"]);
    expect(result.ok && result.data[0]?.code).toBe("DOCK-1");
  });

  it("returns lookup errors", async () => {
    const { db } = client({
      "from:counterparties": [errorResponse("42501", "no")],
      "from:std_enumeration": [errorResponse("42501", "no")],
      "from:zones": [errorResponse("42501", "no")],
      "from:projects": [errorResponse("42501", "no")],
    });
    for (const result of [
      await listCounterpartyOptions(db, "o1"),
      await listFreightTypes(db),
      await listZoneOptions(db, ["v1"]),
      await listOperationsProjects(db, "o1"),
    ]) {
      expect(result).toEqual({ ok: false, error: { kind: "not-found" } });
    }
  });
});

describe("shipments", () => {
  it("lists shipments with key, carrier, progress and live line count", async () => {
    const { db, calls } = client({ "from:shipments": [okResponse([shipmentRow])] });
    const result = await listShipments(db, { orgId: "o1", projectId: "p1" });
    expect(result.ok && result.data[0]).toMatchObject({
      key: "NWL-12",
      carrierName: "Bayside Freight",
      progress: "booked",
      lineCount: 1,
      timeZone: "America/New_York",
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["project_id", "p1"]]);
  });

  it("reads one shipment with its lines, slots, gate entries and log", async () => {
    const { db } = client({
      "from:shipments": [okResponse(shipmentRow)],
      "from:shipment_lines": [
        okResponse([{ id: "sl1", description: "Truss", element_id: null, quantity: "4" }]),
      ],
      "from:dock_slots": [okResponse([slotRow])],
      "from:gate_queue": [okResponse([gateRow])],
      "from:marshalling_log": [okResponse([logRow])],
    });
    const result = await getShipment(db, "s1");
    expect(result.ok && result.data.lines[0]?.quantity).toBe(4);
    expect(result.ok && result.data.dockSlots[0]?.zoneCode).toBe("DOCK-1");
    expect(result.ok && result.data.gateEntries[0]?.vehicleIdentifier).toBe("FL-TRK-221");
    expect(result.ok && result.data.log[0]?.loggedByName).toBe("Dana Reyes");
    expect(result.ok && result.data.updatedAt).toBe("2027-05-02T00:00:00Z");
  });

  it("answers not-found for a missing shipment and passes child errors on", async () => {
    const missing = client({ "from:shipments": [okResponse(null)] });
    expect(await getShipment(missing.db, "s1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    const broken = client({
      "from:shipments": [okResponse(shipmentRow)],
      "from:shipment_lines": [errorResponse("XX000", "lines down")],
      "from:dock_slots": [okResponse([])],
      "from:gate_queue": [okResponse([])],
      "from:marshalling_log": [okResponse([])],
    });
    expect((await getShipment(broken.db, "s1")).ok).toBe(false);
    for (const failing of ["from:dock_slots", "from:gate_queue", "from:marshalling_log"]) {
      const queues: Record<string, Response[]> = {
        "from:shipments": [okResponse(shipmentRow)],
        "from:shipment_lines": [okResponse([])],
        "from:dock_slots": [okResponse([])],
        "from:gate_queue": [okResponse([])],
        "from:marshalling_log": [okResponse([])],
      };
      queues[failing] = [errorResponse("XX000", "down")];
      expect((await getShipment(client(queues).db, "s1")).ok).toBe(false);
    }
    const listError = client({ "from:shipments": [errorResponse("XX000", "down")] });
    expect((await listShipments(listError.db, { orgId: "o1" })).ok).toBe(false);
    const readError = client({ "from:shipments": [errorResponse("XX000", "down")] });
    expect((await getShipment(readError.db, "s1")).ok).toBe(false);
  });

  it("creates, edits with a version check, deletes and restores", async () => {
    const { db, calls } = client({
      "from:shipments": [
        okResponse([{ id: "s9" }]),
        okResponse([{ id: "s9" }]),
        okResponse([]),
        okResponse([]),
        okResponse([{ id: "s9" }]),
        okResponse([{ id: "s9" }]),
      ],
    });
    expect(await createShipment(db, "p1", input)).toEqual({ ok: true, data: { id: "s9" } });
    expect(await updateShipment(db, "s9", input, "v1")).toEqual({ ok: true, data: null });
    expect(await updateShipment(db, "s9", input, "v1")).toEqual({
      ok: false,
      error: { kind: "conflict", message: "shipment_changed" },
    });
    expect(await updateShipment(db, "s9", input)).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await deleteShipment(db, "s9")).ok).toBe(true);
    expect((await restoreShipment(db, "s9")).ok).toBe(true);
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [
        {
          project_id: "p1",
          direction: "Inbound",
          carrier_counterparty_id: null,
          freight_type_enum_id: "ENM-022",
          tracking_identifier: null,
          ships_at: null,
          arrives_at: "2027-06-01T10:00:00Z",
        },
      ],
    ]);
    expect(calls[5]?.steps[0]).toEqual(["update", [{ deleted_at: null }]]);
  });

  it("maps write errors", async () => {
    const { db } = client({
      "from:shipments": [
        errorResponse("XR001", "freight_type: Not a freight type.", "freight_type"),
        errorResponse("42501", "no"),
        errorResponse("42501", "no"),
        okResponse([]),
      ],
    });
    expect(await createShipment(db, "p1", input)).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "freight_type", message: "Not a freight type." },
    });
    expect((await updateShipment(db, "s1", input)).ok).toBe(false);
    expect((await deleteShipment(db, "s1")).ok).toBe(false);
    expect(await createShipment(db, "p1", input)).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("adds and removes manifest lines", async () => {
    const { db } = client({
      "from:shipment_lines": [
        okResponse([{ id: "sl1" }]),
        errorResponse("23514", "quantity"),
        okResponse([{ id: "sl1" }]),
      ],
    });
    expect((await addShipmentLine(db, "s1", { description: "Truss", quantity: 4 })).ok).toBe(true);
    expect(
      (await addShipmentLine(db, "s1", { description: "Truss", quantity: 0, elementId: null })).ok,
    ).toBe(false);
    expect((await removeShipmentLine(db, "sl1")).ok).toBe(true);
  });
});

describe("dock slots", () => {
  it("lists slots in a window with check-in and engagement", async () => {
    const { db, calls } = client({
      "from:dock_slots": [
        okResponse([{ ...slotRow, checked_in_at: "t", checker: { full_name: "Frank Field" } }]),
      ],
    });
    const result = await listDockSlots(db, {
      orgId: "o1",
      projectId: "p1",
      from: "2027-06-01T00:00:00Z",
      to: "2027-06-08T00:00:00Z",
    });
    expect(result.ok && result.data[0]?.checkedInByName).toBe("Frank Field");
    expect(calls[0]?.steps).toContainEqual(["gt", ["ends_at", "2027-06-01T00:00:00Z"]]);
    expect(calls[0]?.steps).toContainEqual(["lt", ["starts_at", "2027-06-08T00:00:00Z"]]);
  });

  it("books, moves, checks in, cancels and restores", async () => {
    const slot = { zoneId: "z1", shipmentId: "s1", startsAt: "a", endsAt: "b" };
    const { db, calls } = client({
      "from:dock_slots": [
        okResponse([{ id: "d1" }]),
        errorResponse("XR001", "dock_slot_overlap: Slots at one dock never overlap."),
        okResponse([{ id: "d1" }]),
        okResponse([]),
        okResponse([{ id: "d1" }]),
        okResponse([]),
        okResponse([{ id: "d1" }]),
        okResponse([{ id: "d1" }]),
        errorResponse("XX000", "down"),
        errorResponse("XX000", "down"),
      ],
    });
    expect((await bookDockSlot(db, "p1", slot)).ok).toBe(true);
    expect(await bookDockSlot(db, "p1", slot)).toEqual({
      ok: false,
      error: {
        kind: "refusal",
        rule: "dock_slot_overlap",
        message: "Slots at one dock never overlap.",
      },
    });
    expect((await updateDockSlot(db, "d1", { ...slot, engagementId: "e1" })).ok).toBe(true);
    expect((await updateDockSlot(db, "d1", slot)).ok).toBe(false);
    expect((await checkInDockSlot(db, "d1")).ok).toBe(true);
    expect((await checkInDockSlot(db, "d1")).ok).toBe(false);
    expect((await cancelDockSlot(db, "d1")).ok).toBe(true);
    expect((await restoreDockSlot(db, "d1")).ok).toBe(true);
    expect((await updateDockSlot(db, "d1", slot)).ok).toBe(false);
    expect((await checkInDockSlot(db, "d1")).ok).toBe(false);
    expect(calls[2]?.steps[0]?.[1]).toEqual([
      { zone_id: "z1", shipment_id: "s1", engagement_id: "e1", starts_at: "a", ends_at: "b" },
    ]);
    const listError = client({ "from:dock_slots": [errorResponse("XX000", "down")] });
    expect((await listDockSlots(listError.db, { orgId: "o1" })).ok).toBe(false);
  });
});

describe("gate queue and yard log", () => {
  it("lists waiting vehicles and records arrivals and releases", async () => {
    const { db, calls } = client({
      "from:gate_queue": [
        okResponse([{ ...gateRow, released_at: "t", releaser: { full_name: "Dana Reyes" } }]),
        okResponse([{ id: "g2" }]),
        okResponse([{ id: "g2" }]),
        okResponse([]),
        errorResponse("42501", "logistics.release.approve is required"),
        okResponse([{ id: "g2" }]),
        errorResponse("XX000", "down"),
        errorResponse("XX000", "down"),
      ],
    });
    const list = await listGateQueue(db, { orgId: "o1", projectId: "p1", waiting: true });
    expect(list.ok && list.data[0]?.releasedByName).toBe("Dana Reyes");
    expect(calls[0]?.steps).toContainEqual(["is", ["released_at", null]]);
    expect(
      (await recordGateArrival(db, "p1", { vehicleIdentifier: "FL-1", shipmentId: null })).ok,
    ).toBe(true);
    expect(await releaseVehicle(db, "g2")).toEqual({ ok: true, data: null });
    expect(await releaseVehicle(db, "g2")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect(await releaseVehicle(db, "g2")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await removeGateEntry(db, "g2")).ok).toBe(true);
    expect((await listGateQueue(db, { orgId: "o1" })).ok).toBe(false);
    expect(
      (await recordGateArrival(db, "p1", { vehicleIdentifier: "FL-1", shipmentId: null })).ok,
    ).toBe(false);
  });

  it("reads the log newest first and appends entries", async () => {
    const { db, calls } = client({
      "from:marshalling_log": [
        okResponse([logRow]),
        okResponse([{ id: "l2" }]),
        errorResponse("XX000", "down"),
        errorResponse("23514", "entry length"),
      ],
    });
    const list = await listMarshallingLog(db, { orgId: "o1", projectId: "p1" });
    expect(list.ok && list.data[0]?.entry).toBe("Staged in lane 2.");
    expect(calls[0]?.steps).toContainEqual(["order", ["logged_at", { ascending: false }]]);
    expect(
      (await addMarshallingEntry(db, "p1", { entry: "Moved.", shipmentId: null, zoneId: null })).ok,
    ).toBe(true);
    expect((await listMarshallingLog(db, { orgId: "o1" })).ok).toBe(false);
    expect(
      await addMarshallingEntry(db, "p1", { entry: "", shipmentId: null, zoneId: null }),
    ).toEqual({ ok: false, error: { kind: "invalid", message: "entry length" } });
  });
});

describe("access", () => {
  it("answers per project and capability from the database rule", async () => {
    const { db } = client({
      "rpc:operations_project_capabilities": [
        okResponse([
          { project_id: "p1", capability_code: "logistics.shipment.write" },
          { project_id: "p2", capability_code: "logistics.shipment.write" },
          { project_id: "p1", capability_code: "logistics.release.approve" },
        ]),
        errorResponse("42501", "no"),
      ],
    });
    const result = await getOperationsAccess(db, "o1");
    expect(result.ok && result.data.can("p1", "logistics.release.approve")).toBe(true);
    expect(result.ok && result.data.can("p2", "logistics.release.approve")).toBe(false);
    expect(result.ok && [...result.data.projectsWith("logistics.shipment.write")]).toEqual([
      "p1",
      "p2",
    ]);
    expect(result.ok && result.data.projectsWith("hospitality.beo.approve").size).toBe(0);
    expect((await getOperationsAccess(db, "o1")).ok).toBe(false);
  });
});
