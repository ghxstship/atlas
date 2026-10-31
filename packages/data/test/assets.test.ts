import { describe, expect, it } from "vitest";
import {
  ASSET_STATES,
  addAssetIdentifier,
  applyAssetScanEvent,
  archiveAssetClass,
  assetStateKey,
  countAssetLot,
  createAssetClass,
  createAssetLot,
  createAssetUnit,
  getAssetUnit,
  getAssetUnitProvenance,
  isAssetState,
  isAssetTag,
  listAssetClasses,
  listAssetConditions,
  listAssetCustody,
  listAssetDamage,
  listAssetLotMovements,
  listAssetLots,
  listAssetMaintenance,
  listAssetProjects,
  listAssetTransitions,
  listAssetUnitHire,
  listAssetUnits,
  listAssetVenues,
  listReceiptStock,
  lotScanCode,
  normalizeAssetTag,
  recordAssetCustody,
  recordAssetMaintenance,
  removeAssetIdentifier,
  renameAssetClass,
  reportAssetDamage,
  resolveAssetScan,
  resolveAssetsProject,
  scanActionsFor,
  searchAssetElements,
  transitionAssetUnit,
  updateAssetUnit,
} from "../src/assets.ts";
import { errorResponse, fakeClient, okResponse, type Response } from "./fake-client.ts";

/** The shared fake client plus `schema(name).from(table)`, recorded as `from:<schema>.<table>`. */
function client(queues: Record<string, Response[]>) {
  const fake = fakeClient(queues);
  const db = fake.db as unknown as Record<string, unknown> & {
    from: (t: string) => unknown;
  };
  db["schema"] = (name: string) => ({ from: (table: string) => db.from(`${name}.${table}`) });
  return fake;
}

const custodyRow = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  created_at: "2026-10-01T10:00:00Z",
  custodian_membership_id: "m1",
  custodian_engagement_id: null,
  venue_id: null,
  project_id: "p1",
  note: "Out for load-in.",
  custodian: { person: { full_name: "Frank Adeyemi" } },
  engagement: null,
  venue: null,
  project: { project_key: "NWL" },
  ...over,
});

const unitRow = (over: Record<string, unknown> = {}) => ({
  id: "u1",
  asset_tag: "NWL-RAD-001",
  asset_class_id: "k1",
  asset_state: "Deployed",
  condition_enum_id: "ENM-017",
  home_venue_id: "v1",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  asset_class: { name: "Digital Radio" },
  home_venue: { name: "Northwind Warehouse" },
  asset_custody: [
    custodyRow({ id: "c0", created_at: "2026-09-20T10:00:00Z", project_id: null, project: null }),
    custodyRow(),
  ],
  ...over,
});

describe("asset states", () => {
  it("lists the ten states from the generated enum, Returned last", () => {
    expect(ASSET_STATES).toHaveLength(10);
    expect(ASSET_STATES.at(-1)).toBe("Returned");
    expect(isAssetState("In Maintenance")).toBe(true);
    expect(isAssetState("Broken")).toBe(false);
  });

  it("derives catalog keys", () => {
    expect(assetStateKey("In Maintenance")).toBe("inMaintenance");
    expect(assetStateKey("Available")).toBe("available");
  });

  it("normalizes and checks asset tags", () => {
    expect(normalizeAssetTag("  nwl-rad-001 ")).toBe("NWL-RAD-001");
    expect(isAssetTag("NWL-RAD-001")).toBe(true);
    expect(isAssetTag("N")).toBe(false);
    expect(isAssetTag("bad tag")).toBe(false);
  });

  it("offers scan actions only from the states the RPC accepts", () => {
    expect(scanActionsFor("Available")).toEqual(["check-out"]);
    expect(scanActionsFor("Deployed")).toEqual(["check-in", "transfer"]);
    expect(scanActionsFor("Damaged")).toEqual([]);
    expect(lotScanCode("abc")).toBe("LOT:abc");
  });
});

describe("reference reads", () => {
  it("reads canon conditions in canon order", async () => {
    const { db, calls } = client({
      "from:xpms.std_enumeration": [
        okResponse([
          { record_id: "ENM-015", enum_label: "New", sort_order: 1 },
          { record_id: "ENM-099", enum_label: null, sort_order: 2 },
        ]),
      ],
    });
    const result = await listAssetConditions(db);
    expect(result).toEqual({
      ok: true,
      data: [
        { id: "ENM-015", label: "New" },
        { id: "ENM-099", label: "ENM-099" },
      ],
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["enum_domain", "Asset Condition"]]);
  });

  it("searches elements by item or id, stripping filter syntax", async () => {
    const { db, calls } = client({
      "from:xpms.elements": [
        okResponse([{ element_id: "E1", urid: "9000.03.01", item: "Radio" }]),
        okResponse([]),
        errorResponse("XX000", "boom"),
      ],
    });
    const found = await searchAssetElements(db, " radio, (x) ");
    expect(found.ok && found.data[0]?.item).toBe("Radio");
    expect(calls[0]?.steps.find((s) => s[0] === "or")?.[1]).toEqual([
      "item.ilike.%radio   x %,element_id.ilike.%radio   x %",
    ]);
    await searchAssetElements(db, "");
    expect(calls[1]?.steps.some((s) => s[0] === "or")).toBe(false);
    expect((await searchAssetElements(db, "x")).ok).toBe(false);
  });

  it("lists venues and projects", async () => {
    const { db } = client({
      "from:venues": [okResponse([{ id: "v1", name: "Warehouse" }]), errorResponse("42501", "no")],
      "from:projects": [
        okResponse([{ id: "p1", project_key: "NWL", name: "Summer Series" }]),
        errorResponse("XX000", "x"),
      ],
    });
    expect(await listAssetVenues(db, "o1")).toEqual({
      ok: true,
      data: [{ id: "v1", name: "Warehouse" }],
    });
    expect((await listAssetVenues(db, "o1")).ok).toBe(false);
    expect(await listAssetProjects(db, "o1")).toEqual({
      ok: true,
      data: [{ id: "p1", key: "NWL", name: "Summer Series" }],
    });
    expect((await listAssetProjects(db, "o1")).ok).toBe(false);
  });

  it("resolves a project tab's project or answers not-found", async () => {
    const { db } = client({
      "from:projects": [
        okResponse({ id: "p1", project_key: "NWL", name: "Summer Series" }),
        okResponse(null),
        errorResponse("XX000", "x"),
      ],
    });
    expect(await resolveAssetsProject(db, "o1", "NWL")).toEqual({
      ok: true,
      data: { id: "p1", key: "NWL", name: "Summer Series" },
    });
    expect(await resolveAssetsProject(db, "o1", "ZZZ")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await resolveAssetsProject(db, "o1", "NWL")).ok).toBe(false);
  });

  it("maps the asset transition rules in lifecycle order", async () => {
    const { db } = client({
      "from:lifecycle_transition_rules": [
        okResponse([
          { from_state: "Available", to_state: "Retired" },
          { from_state: "Available", to_state: "Reserved" },
          { from_state: "Bogus", to_state: "Available" },
          { from_state: null, to_state: null },
        ]),
        errorResponse("XX000", "x"),
      ],
    });
    const result = await listAssetTransitions(db);
    expect(result.ok && result.data.get("Available")).toEqual(["Reserved", "Retired"]);
    expect(result.ok && result.data.size).toBe(1);
    expect((await listAssetTransitions(db)).ok).toBe(false);
  });
});

describe("asset classes", () => {
  it("lists classes with element and live counts", async () => {
    const { db } = client({
      "from:asset_classes": [
        okResponse([
          {
            id: "k1",
            name: "Digital Radio",
            element_id: "E1",
            created_at: "2026-09-01T00:00:00Z",
            asset_units: [
              { id: "u1", deleted_at: null },
              { id: "u2", deleted_at: "2026-09-02T00:00:00Z" },
            ],
            asset_lots: [{ id: "l1", deleted_at: null }],
          },
          {
            id: "k2",
            name: "Truss",
            element_id: "E9",
            created_at: "2026-09-01T00:00:00Z",
            asset_units: [],
            asset_lots: [],
          },
        ]),
      ],
      "from:xpms.elements": [okResponse([{ element_id: "E1", urid: "9000.03.01", item: "Radio" }])],
    });
    const result = await listAssetClasses(db, "o1");
    expect(result.ok && result.data[0]).toMatchObject({
      unitCount: 1,
      lotCount: 1,
      urid: "9000.03.01",
      elementItem: "Radio",
    });
    expect(result.ok && result.data[1]?.urid).toBeNull();
  });

  it("returns read errors for classes and their elements", async () => {
    const { db } = client({
      "from:asset_classes": [
        errorResponse("42501", "no"),
        okResponse([
          {
            id: "k1",
            name: "x",
            element_id: "E1",
            created_at: "",
            asset_units: [],
            asset_lots: [],
          },
        ]),
        okResponse([]),
      ],
      "from:xpms.elements": [errorResponse("XX000", "x")],
    });
    expect(await listAssetClasses(db, "o1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await listAssetClasses(db, "o1")).ok).toBe(false);
    expect(await listAssetClasses(db, "o1")).toEqual({ ok: true, data: [] });
  });

  it("creates, renames and validates names", async () => {
    const { db, calls } = client({
      "from:asset_classes": [
        okResponse({ id: "k1" }),
        errorResponse("23505", "duplicate key"),
        okResponse(null),
        errorResponse("42501", "no"),
      ],
    });
    expect(await createAssetClass(db, { orgId: "o1", elementId: "E1", name: " Radio " })).toEqual({
      ok: true,
      data: { id: "k1" },
    });
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [{ org_id: "o1", element_id: "E1", name: "Radio" }],
    ]);
    expect((await createAssetClass(db, { orgId: "o1", elementId: "E1", name: "Radio" })).ok).toBe(
      false,
    );
    expect(await createAssetClass(db, { orgId: "o1", elementId: "E1", name: "  " })).toEqual({
      ok: false,
      error: { kind: "invalid", message: "name" },
    });
    expect(await renameAssetClass(db, "k1", "Radios")).toEqual({ ok: true, data: null });
    expect((await renameAssetClass(db, "k1", "Radios")).ok).toBe(false);
    expect((await renameAssetClass(db, "k1", "")).ok).toBe(false);
  });

  it("archives only an empty class", async () => {
    const { db } = client({
      "from:asset_classes": [
        okResponse({ id: "k1", asset_units: [{ id: "u1", deleted_at: null }], asset_lots: [] }),
        okResponse({ id: "k1", asset_units: [], asset_lots: [] }),
        okResponse(null),
        okResponse(null),
        errorResponse("XX000", "x"),
        okResponse({ id: "k1", asset_units: [], asset_lots: [] }),
        errorResponse("42501", "no"),
      ],
    });
    const refused = await archiveAssetClass(db, "k1");
    expect(!refused.ok && refused.error).toMatchObject({
      kind: "refusal",
      rule: "asset_class_in_use",
    });
    expect(await archiveAssetClass(db, "k1")).toEqual({ ok: true, data: null });
    expect(await archiveAssetClass(db, "k9")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await archiveAssetClass(db, "k1")).ok).toBe(false);
    expect((await archiveAssetClass(db, "k1")).ok).toBe(false);
  });
});

describe("asset units", () => {
  it("lists units with their latest custodian and filters by project", async () => {
    const { db, calls } = client({
      "from:asset_units": [
        okResponse([unitRow(), unitRow({ id: "u2", asset_tag: "NWL-RAD-002", asset_custody: [] })]),
        okResponse([unitRow(), unitRow({ id: "u2", asset_custody: [] })]),
        errorResponse("XX000", "x"),
      ],
    });
    const all = await listAssetUnits(db, "o1", { classId: "k1", state: "Deployed" });
    expect(all.ok && all.data[0]?.custody).toMatchObject({
      custodyId: "c1",
      custodianName: "Frank Adeyemi",
      projectKey: "NWL",
      engagementId: null,
    });
    expect(all.ok && all.data[1]?.custody).toBeNull();
    expect(calls[0]?.steps).toContainEqual(["eq", ["asset_class_id", "k1"]]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["asset_state", "Deployed"]]);
    const onProject = await listAssetUnits(db, "o1", { projectId: "p1" });
    expect(onProject.ok && onProject.data.map((u) => u.id)).toEqual(["u1"]);
    expect((await listAssetUnits(db, "o1")).ok).toBe(false);
  });

  it("names an engagement custodian and breaks custody ties by id", async () => {
    const { db } = client({
      "from:asset_units": [
        okResponse([
          unitRow({
            asset_class: null,
            home_venue: null,
            asset_custody: [
              custodyRow({ id: "c1" }),
              custodyRow({
                id: "c2",
                custodian_membership_id: null,
                custodian_engagement_id: "e1",
                custodian: null,
                engagement: { person: { full_name: "Ivy Marchetti" } },
              }),
            ],
          }),
        ]),
      ],
    });
    const result = await listAssetUnits(db, "o1");
    expect(result.ok && result.data[0]?.custody).toMatchObject({
      engagementId: "e1",
      custodianName: "Ivy Marchetti",
    });
    expect(result.ok && result.data[0]?.className).toBe("");
  });

  it("reads one unit with its history", async () => {
    const { db } = client({
      "from:asset_units": [
        okResponse({
          ...unitRow(),
          asset_class_element: { element_id: "E1" },
          asset_identifiers: [
            { id: "i2", scheme: "serial", value: "B", deleted_at: null },
            { id: "i1", scheme: "gtin14", value: "A", deleted_at: null },
            { id: "i3", scheme: "serial", value: "A", deleted_at: null },
            { id: "i0", scheme: "mpn", value: "Z", deleted_at: "2026-01-01" },
          ],
          asset_state_transitions: [
            {
              id: "t1",
              from_state: null,
              to_state: "Proposed",
              reason: null,
              created_at: "2026-09-01T00:00:00Z",
            },
            {
              id: "t2",
              from_state: "Proposed",
              to_state: "Received",
              reason: "Delivered.",
              created_at: "2026-09-02T00:00:00Z",
            },
          ],
        }),
      ],
      "from:asset_maintenance": [okResponse([])],
      "from:asset_damage": [okResponse([])],
    });
    const result = await getAssetUnit(db, "o1", "nwl-rad-001");
    expect(result.ok && result.data.identifiers.map((i) => i.id)).toEqual(["i1", "i3", "i2"]);
    expect(result.ok && result.data.transitions[0]?.toState).toBe("Received");
    expect(result.ok && result.data.custodyHistory.map((c) => c.custodyId)).toEqual(["c1", "c0"]);
    expect(result.ok && result.data.elementId).toBe("E1");
  });

  it("answers not-found for a bad tag, a missing unit and passes errors", async () => {
    const { db } = client({
      "from:asset_units": [
        okResponse(null),
        errorResponse("XX000", "x"),
        okResponse({
          ...unitRow(),
          asset_class_element: null,
          asset_identifiers: [],
          asset_state_transitions: [],
        }),
        okResponse({
          ...unitRow(),
          asset_class_element: null,
          asset_identifiers: [],
          asset_state_transitions: [],
        }),
      ],
      "from:asset_maintenance": [errorResponse("XX000", "m"), okResponse([])],
      "from:asset_damage": [okResponse([]), errorResponse("XX000", "d")],
    });
    expect(await getAssetUnit(db, "o1", "bad tag")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect(await getAssetUnit(db, "o1", "NWL-X")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await getAssetUnit(db, "o1", "NWL-X")).ok).toBe(false);
    expect((await getAssetUnit(db, "o1", "NWL-X")).ok).toBe(false);
    expect((await getAssetUnit(db, "o1", "NWL-X")).ok).toBe(false);
  });

  it("registers, edits and moves units", async () => {
    const { db, calls } = client({
      "from:asset_units": [
        okResponse({ id: "u1", asset_tag: "NWL-RAD-001" }),
        errorResponse("23505", "duplicate"),
        okResponse(null),
        errorResponse("42501", "no"),
      ],
      "rpc:transition_asset": [
        okResponse("t9"),
        errorResponse(
          "XR001",
          "asset_transition_not_allowed: A asset cannot move.",
          "asset_transition_not_allowed",
        ),
      ],
    });
    expect(
      await createAssetUnit(db, {
        orgId: "o1",
        classId: "k1",
        assetTag: " nwl-rad-001",
        conditionEnumId: null,
        homeVenueId: "v1",
      }),
    ).toEqual({ ok: true, data: { id: "u1", assetTag: "NWL-RAD-001" } });
    expect(
      await createAssetUnit(db, {
        orgId: "o1",
        classId: "k1",
        assetTag: "NWL-RAD-001",
        conditionEnumId: null,
        homeVenueId: null,
      }),
    ).toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(
      await createAssetUnit(db, {
        orgId: "o1",
        classId: "k1",
        assetTag: "n",
        conditionEnumId: null,
        homeVenueId: null,
      }),
    ).toEqual({ ok: false, error: { kind: "invalid", message: "assetTag" } });
    expect(
      await updateAssetUnit(db, "u1", { conditionEnumId: "ENM-018", homeVenueId: null }),
    ).toEqual({ ok: true, data: null });
    expect((await updateAssetUnit(db, "u1", { conditionEnumId: null, homeVenueId: null })).ok).toBe(
      false,
    );
    expect(
      await transitionAssetUnit(db, {
        unitId: "u1",
        expected: "Available",
        next: "Reserved",
        reason: " Held for NWL. ",
      }),
    ).toEqual({ ok: true, data: { transitionId: "t9" } });
    expect(calls.find((c) => c.target === "rpc:transition_asset")?.steps[0]).toEqual([
      "args",
      [
        {
          p_asset_unit_id: "u1",
          p_expected: "Available",
          p_next: "Reserved",
          p_reason: "Held for NWL.",
        },
      ],
    ]);
    const refused = await transitionAssetUnit(db, {
      unitId: "u1",
      expected: "Available",
      next: "Lost",
      reason: "x",
    });
    expect(!refused.ok && refused.error).toMatchObject({ rule: "asset_transition_not_allowed" });
    const noReason = await transitionAssetUnit(db, {
      unitId: "u1",
      expected: "Available",
      next: "Reserved",
      reason: "  ",
    });
    expect(!noReason.ok && noReason.error).toMatchObject({ rule: "transition_reason_required" });
  });

  it("records and removes identifiers", async () => {
    const { db } = client({
      "from:asset_identifiers": [
        okResponse({ id: "i1" }),
        errorResponse("23505", "dup"),
        okResponse(null),
        errorResponse("42501", "no"),
      ],
    });
    expect(
      await addAssetIdentifier(db, {
        orgId: "o1",
        unitId: "u1",
        scheme: " Serial ",
        value: " SN1 ",
      }),
    ).toEqual({ ok: true, data: { id: "i1" } });
    expect(
      (await addAssetIdentifier(db, { orgId: "o1", unitId: "u1", scheme: "serial", value: "SN1" }))
        .ok,
    ).toBe(false);
    expect(
      await addAssetIdentifier(db, { orgId: "o1", unitId: "u1", scheme: "9x", value: "SN1" }),
    ).toEqual({ ok: false, error: { kind: "invalid", message: "scheme" } });
    expect(
      await addAssetIdentifier(db, { orgId: "o1", unitId: "u1", scheme: "serial", value: "" }),
    ).toEqual({ ok: false, error: { kind: "invalid", message: "value" } });
    expect(await removeAssetIdentifier(db, "i1")).toEqual({ ok: true, data: null });
    expect((await removeAssetIdentifier(db, "i1")).ok).toBe(false);
  });
});

describe("lots", () => {
  it("lists lots with quantity on hand from the ledger", async () => {
    const { db } = client({
      "from:asset_lots": [
        okResponse([
          {
            id: "l2",
            asset_class_id: "k2",
            venue_id: "v1",
            quantity: "40",
            updated_at: "",
            asset_class: { name: "Truss" },
            venue: { name: "Warehouse" },
          },
          {
            id: "l1",
            asset_class_id: "k1",
            venue_id: "v2",
            quantity: 10,
            updated_at: "",
            asset_class: null,
            venue: null,
          },
        ]),
        okResponse([]),
        errorResponse("XX000", "x"),
        okResponse([
          {
            id: "l1",
            asset_class_id: "k1",
            venue_id: "v2",
            quantity: 10,
            updated_at: "",
            asset_class: null,
            venue: null,
          },
        ]),
      ],
      "from:asset_lot_balances": [
        okResponse([{ asset_lot_id: "l2", on_hand: "35" }]),
        errorResponse("XX000", "b"),
      ],
    });
    const result = await listAssetLots(db, "o1", { classId: "k1" });
    expect(result.ok && result.data.map((l) => [l.id, l.openingQuantity, l.onHand])).toEqual([
      ["l1", 10, 10],
      ["l2", 40, 35],
    ]);
    expect(await listAssetLots(db, "o1")).toEqual({ ok: true, data: [] });
    expect((await listAssetLots(db, "o1")).ok).toBe(false);
    expect((await listAssetLots(db, "o1")).ok).toBe(false);
  });

  it("lists a lot's movements", async () => {
    const { db } = client({
      "from:asset_lot_movements": [
        okResponse([
          {
            id: "mv1",
            movement_kind: "Check Out",
            delta: "-5",
            custodian_membership_id: "m1",
            project_id: "p1",
            note: null,
            created_at: "2026-10-02T00:00:00Z",
            custodian: { person: { full_name: "Dave Lindqvist" } },
            project: { project_key: "NWL" },
          },
          {
            id: "mv0",
            movement_kind: "Count",
            delta: 2,
            custodian_membership_id: null,
            project_id: null,
            note: "Recount.",
            created_at: "2026-10-01T00:00:00Z",
            custodian: null,
            project: null,
          },
        ]),
        okResponse(null),
        errorResponse("XX000", "x"),
      ],
    });
    const result = await listAssetLotMovements(db, "l1");
    expect(result.ok && result.data[0]).toMatchObject({
      delta: -5,
      custodianName: "Dave Lindqvist",
      projectKey: "NWL",
    });
    expect(result.ok && result.data[1]?.custodianName).toBeNull();
    expect(await listAssetLotMovements(db, "l1")).toEqual({ ok: true, data: [] });
    expect((await listAssetLotMovements(db, "l1")).ok).toBe(false);
  });

  it("creates lots and recounts through the RPC", async () => {
    const { db } = client({
      "from:asset_lots": [okResponse({ id: "l1" }), errorResponse("23505", "dup")],
      "rpc:count_asset_lot": [
        okResponse("mv1"),
        okResponse(null),
        errorResponse("42501", "assets.asset.write is required"),
      ],
    });
    expect(
      await createAssetLot(db, { orgId: "o1", classId: "k1", venueId: "v1", quantity: 12 }),
    ).toEqual({ ok: true, data: { id: "l1" } });
    expect(
      (await createAssetLot(db, { orgId: "o1", classId: "k1", venueId: "v1", quantity: 1 })).ok,
    ).toBe(false);
    expect(
      await createAssetLot(db, { orgId: "o1", classId: "k1", venueId: "v1", quantity: -1 }),
    ).toEqual({ ok: false, error: { kind: "invalid", message: "quantity" } });
    expect(await countAssetLot(db, { lotId: "l1", counted: 8, note: " Bent. " })).toEqual({
      ok: true,
      data: { movementId: "mv1" },
    });
    expect(await countAssetLot(db, { lotId: "l1", counted: 8, note: null })).toEqual({
      ok: true,
      data: { movementId: null },
    });
    expect(await countAssetLot(db, { lotId: "l1", counted: 8, note: null })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect(await countAssetLot(db, { lotId: "l1", counted: Number.NaN, note: null })).toEqual({
      ok: false,
      error: { kind: "invalid", message: "quantity" },
    });
  });
});

describe("custody ledger", () => {
  it("lists custody newest first with filters", async () => {
    const { db, calls } = client({
      "from:asset_custody": [
        okResponse([
          {
            ...custodyRow(),
            asset_unit_id: "u1",
            unit: { asset_tag: "NWL-RAD-001", asset_class: { name: "Radio" } },
          },
          { ...custodyRow({ id: "c2" }), asset_unit_id: "u2", unit: null },
        ]),
        errorResponse("XX000", "x"),
      ],
    });
    const result = await listAssetCustody(db, "o1", { unitId: "u1", projectId: "p1", limit: 5 });
    expect(result.ok && result.data[0]).toMatchObject({
      assetTag: "NWL-RAD-001",
      className: "Radio",
    });
    expect(result.ok && result.data[1]?.assetTag).toBe("");
    expect(calls[0]?.steps).toContainEqual(["limit", [5]]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["project_id", "p1"]]);
    expect((await listAssetCustody(db, "o1")).ok).toBe(false);
  });

  it("records custody through app.record_asset_custody, to one custodian or a place", async () => {
    const { db, calls } = client({
      "rpc:record_asset_custody": [
        okResponse("c9"),
        okResponse("c10"),
        errorResponse("42501", "no"),
      ],
    });
    expect(
      await recordAssetCustody(db, {
        orgId: "o1",
        unitId: "u1",
        membershipId: "m1",
        venueId: null,
        projectId: "p1",
        note: "  ",
      }),
    ).toEqual({ ok: true, data: { id: "c9" } });
    expect(calls[0]?.steps[0]?.[1]?.[0]).toEqual({
      p_asset_unit_id: "u1",
      p_custodian_membership_id: "m1",
      p_project_id: "p1",
    });
    expect(
      await recordAssetCustody(db, {
        orgId: "o1",
        unitId: "u1",
        membershipId: null,
        engagementId: "e1",
        venueId: null,
        projectId: null,
        note: "Crew kit.",
        rosterEntryId: "r1",
        reservationId: "h1",
      }),
    ).toEqual({ ok: true, data: { id: "c10" } });
    expect(calls[1]?.steps[0]?.[1]?.[0]).toEqual({
      p_asset_unit_id: "u1",
      p_custodian_engagement_id: "e1",
      p_note: "Crew kit.",
      p_roster_entry_id: "r1",
      p_reservation_id: "h1",
    });
    expect(
      (
        await recordAssetCustody(db, {
          orgId: "o1",
          unitId: "u1",
          membershipId: null,
          venueId: "v1",
          projectId: null,
          note: null,
        })
      ).ok,
    ).toBe(false);
    const both = await recordAssetCustody(db, {
      orgId: "o1",
      unitId: "u1",
      membershipId: "m1",
      engagementId: "e1",
      venueId: null,
      projectId: null,
      note: null,
    });
    expect(!both.ok && both.error).toMatchObject({ rule: "asset_custody_one_custodian" });
    const nowhere = await recordAssetCustody(db, {
      orgId: "o1",
      unitId: "u1",
      membershipId: null,
      venueId: null,
      projectId: null,
      note: null,
    });
    expect(!nowhere.ok && nowhere.error).toMatchObject({ rule: "asset_custody_somewhere" });
  });
});

describe("maintenance and damage", () => {
  it("lists and records maintenance with null for unknown cost", async () => {
    const { db, calls } = client({
      "from:asset_maintenance": [
        okResponse([
          {
            id: "mt1",
            asset_unit_id: "u1",
            performed_on: "2026-10-01",
            description: "Battery swap.",
            cost_minor: null,
            currency_code: null,
            created_at: "",
            unit: { asset_tag: "NWL-RAD-001" },
          },
          {
            id: "mt2",
            asset_unit_id: "u2",
            performed_on: "2026-09-01",
            description: "Antenna.",
            cost_minor: 4500,
            currency_code: "USD",
            created_at: "",
            unit: null,
          },
        ]),
        errorResponse("XX000", "x"),
        okResponse({ id: "mt3" }),
        okResponse({ id: "mt4" }),
        errorResponse("42501", "no"),
      ],
    });
    const list = await listAssetMaintenance(db, "o1", { unitId: "u1" });
    expect(list.ok && list.data[0]?.costMinor).toBeNull();
    expect(list.ok && list.data[1]?.assetTag).toBe("");
    expect((await listAssetMaintenance(db, "o1")).ok).toBe(false);
    const base = { orgId: "o1", unitId: "u1", performedOn: "2026-10-01", description: " Swap. " };
    expect(
      await recordAssetMaintenance(db, { ...base, costMinor: null, currencyCode: "USD" }),
    ).toEqual({
      ok: true,
      data: { id: "mt3" },
    });
    expect(calls[2]?.steps[0]?.[1]).toMatchObject([
      { cost_minor: null, currency_code: null, description: "Swap." },
    ]);
    expect(
      await recordAssetMaintenance(db, { ...base, costMinor: 1200, currencyCode: "USD" }),
    ).toEqual({ ok: true, data: { id: "mt4" } });
    expect(
      (await recordAssetMaintenance(db, { ...base, costMinor: 1200, currencyCode: "USD" })).ok,
    ).toBe(false);
    const cases: [
      Partial<typeof base> & { costMinor: number | null; currencyCode: string | null },
      string,
    ][] = [
      [{ description: " ", costMinor: null, currencyCode: null }, "description"],
      [{ performedOn: "10/01/2026", costMinor: null, currencyCode: null }, "performedOn"],
      [{ costMinor: 1.5, currencyCode: "USD" }, "cost"],
      [{ costMinor: -1, currencyCode: "USD" }, "cost"],
      [{ costMinor: 100, currencyCode: null }, "currency"],
      [{ costMinor: 100, currencyCode: "usd" }, "currency"],
    ];
    for (const [over, message] of cases) {
      expect(await recordAssetMaintenance(db, { ...base, ...over })).toEqual({
        ok: false,
        error: { kind: "invalid", message },
      });
    }
  });

  it("lists and reports damage", async () => {
    const { db, calls } = client({
      "from:asset_damage": [
        okResponse([
          {
            id: "d1",
            asset_unit_id: "u1",
            project_id: "p1",
            responsible_counterparty_id: null,
            reported_at: "2026-10-01T00:00:00Z",
            description: "Cracked case.",
            unit: { asset_tag: "NWL-RAD-001", asset_state: "Damaged" },
            project: { project_key: "NWL" },
          },
          {
            id: "d2",
            asset_unit_id: "u2",
            project_id: null,
            responsible_counterparty_id: "cp1",
            reported_at: "2026-09-01T00:00:00Z",
            description: "Scuffed.",
            unit: null,
            project: null,
          },
        ]),
        errorResponse("XX000", "x"),
        okResponse({ id: "d3" }),
        errorResponse("42501", "no"),
      ],
    });
    const list = await listAssetDamage(db, "o1", { unitId: "u1", projectId: "p1" });
    expect(list.ok && list.data[0]).toMatchObject({ projectKey: "NWL", unitState: "Damaged" });
    expect(list.ok && list.data[1]).toMatchObject({
      assetTag: "",
      unitState: null,
      projectKey: null,
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["project_id", "p1"]]);
    expect((await listAssetDamage(db, "o1")).ok).toBe(false);
    expect(
      await reportAssetDamage(db, {
        orgId: "o1",
        unitId: "u1",
        projectId: null,
        description: " Bent. ",
      }),
    ).toEqual({ ok: true, data: { id: "d3" } });
    expect(
      (
        await reportAssetDamage(db, {
          orgId: "o1",
          unitId: "u1",
          projectId: null,
          description: "x",
        })
      ).ok,
    ).toBe(false);
    expect(
      await reportAssetDamage(db, { orgId: "o1", unitId: "u1", projectId: null, description: "" }),
    ).toEqual({ ok: false, error: { kind: "invalid", message: "description" } });
  });
});

describe("scan resolution", () => {
  const resolveRow = (over: Record<string, unknown> = {}) => ({
    subject_kind: "unit",
    subject_id: "u1",
    asset_tag: "NWL-RAD-001",
    class_name: "Digital Radio",
    asset_state: "Available",
    home_venue_id: "v1",
    custodian_membership_id: null,
    custodian_engagement_id: null,
    custody_venue_id: "v1",
    custody_project_id: null,
    custody_since: "2026-10-01T00:00:00Z",
    lot_venue_id: null,
    on_hand: null,
    refusal: null,
    reason: null,
    ...over,
  });

  it("resolves units with their scan actions and lots with on hand", async () => {
    const { db, calls } = client({
      "rpc:resolve_asset_code": [
        okResponse([resolveRow()]),
        okResponse([
          resolveRow({
            subject_kind: "lot",
            subject_id: "l1",
            asset_tag: null,
            asset_state: null,
            lot_venue_id: "v1",
            on_hand: "15",
          }),
        ]),
        okResponse([resolveRow({ asset_state: null, class_name: null, asset_tag: null })]),
      ],
    });
    const unit = await resolveAssetScan(db, { orgId: "o1", code: "nwl-rad-001" });
    expect(unit.ok && unit.data.kind === "unit" && unit.data.actions).toEqual(["check-out"]);
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_org_id: "o1", p_code: "nwl-rad-001" }]]);
    const lot = await resolveAssetScan(db, { orgId: "o1", code: "LOT:l1" });
    expect(lot.ok && lot.data.kind === "lot" && lot.data.lot.onHand).toBe(15);
    const sparse = await resolveAssetScan(db, { orgId: "o1", code: "x" });
    expect(sparse.ok && sparse.data.kind === "unit" && sparse.data.unit.state).toBe("Proposed");
  });

  it("returns NO_ANSWER refusals, never a guess", async () => {
    const { db } = client({
      "rpc:resolve_asset_code": [
        okResponse([
          resolveRow({
            subject_kind: null,
            subject_id: null,
            refusal: "NO_ANSWER",
            reason: "asset_code_ambiguous",
          }),
        ]),
        okResponse([]),
        okResponse([
          resolveRow({ subject_kind: "lot", lot_venue_id: null, on_hand: null, class_name: null }),
        ]),
        errorResponse("42501", "assets.asset.read or assets.custody.write is required"),
      ],
    });
    expect(await resolveAssetScan(db, { orgId: "o1", code: "SN-77" })).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "asset_code_ambiguous", message: "NO_ANSWER" },
    });
    expect(await resolveAssetScan(db, { orgId: "o1", code: "x" })).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "asset_code_unknown", message: "NO_ANSWER" },
    });
    const lot = await resolveAssetScan(db, { orgId: "o1", code: "LOT:x" });
    expect(lot.ok && lot.data.kind === "lot" && lot.data.lot).toEqual({
      id: "u1",
      className: "",
      venueId: "",
      onHand: 0,
    });
    expect(await resolveAssetScan(db, { orgId: "o1", code: "x" })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("applies scan events idempotently through the RPC", async () => {
    const event = "01920000-0000-7000-8450-000000000001";
    const { db, calls } = client({
      "rpc:apply_asset_scan": [
        okResponse([
          {
            outcome: "applied",
            subject_kind: "unit",
            subject_id: "u1",
            ledger_id: event,
            asset_state: "Deployed",
            on_hand: null,
          },
        ]),
        okResponse([
          {
            outcome: "duplicate",
            subject_kind: "lot",
            subject_id: "l1",
            ledger_id: event,
            asset_state: null,
            on_hand: "15",
          },
        ]),
        errorResponse(
          "XR001",
          "asset_scan_state_conflict: The asset is Deployed now; refresh before you scan again.",
          "asset_scan_state_conflict",
        ),
        okResponse([]),
      ],
    });
    const applied = await applyAssetScanEvent(db, {
      eventId: event,
      orgId: "o1",
      code: "NWL-RAD-001",
      action: "check-out",
      membershipId: "m1",
      projectId: "p1",
      note: "  ",
    });
    expect(applied).toEqual({
      ok: true,
      data: {
        outcome: "applied",
        kind: "unit",
        subjectId: "u1",
        ledgerId: event,
        state: "Deployed",
        onHand: null,
      },
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [
        {
          p_event_id: event,
          p_org_id: "o1",
          p_code: "NWL-RAD-001",
          p_action: "check-out",
          p_custodian_membership_id: "m1",
          p_project_id: "p1",
        },
      ],
    ]);
    const duplicate = await applyAssetScanEvent(db, {
      eventId: event,
      orgId: "o1",
      code: "LOT:l1",
      action: "check-out",
      quantity: 5,
      note: "Five panels.",
    });
    expect(duplicate.ok && duplicate.data).toMatchObject({ outcome: "duplicate", onHand: 15 });
    const conflict = await applyAssetScanEvent(db, {
      eventId: event,
      orgId: "o1",
      code: "NWL-RAD-001",
      action: "check-out",
    });
    expect(!conflict.ok && conflict.error).toEqual({
      kind: "refusal",
      rule: "asset_scan_state_conflict",
      message: "The asset is Deployed now; refresh before you scan again.",
    });
    expect(
      await applyAssetScanEvent(db, { eventId: event, orgId: "o1", code: "x", action: "check-in" }),
    ).toMatchObject({ ok: false, error: { kind: "unexpected" } });
    expect(
      await applyAssetScanEvent(db, {
        eventId: "not-a-uuid",
        orgId: "o1",
        code: "x",
        action: "check-in",
      }),
    ).toEqual({ ok: false, error: { kind: "invalid", message: "eventId" } });
  });
});

describe("provenance and hire", () => {
  it("reads a unit's provenance, or nothing for a reader without procurement", async () => {
    const { db, calls } = fakeClient({
      "from:asset_unit_provenance": [
        okResponse({
          receipt_line_id: "rl1",
          goods_receipt_id: "g1",
          received_at: "2027-06-01T10:00:00Z",
          purchase_order_id: "po1",
          po_number: 7,
          project_id: "p1",
          vendor_id: "v1",
          acquisition_kind: "Rental",
          hire_period: '["2027-06-01 10:00:00+00","2027-06-10 12:00:00+00")',
          unit_price_minor: 5000,
          currency_code: "USD",
        }),
        okResponse(null),
        errorResponse("08006", "down"),
      ],
    });
    const found = await getAssetUnitProvenance(db, "u1");
    expect(found.ok && found.data).toEqual({
      receiptLineId: "rl1",
      goodsReceiptId: "g1",
      receivedAt: "2027-06-01T10:00:00Z",
      purchaseOrderId: "po1",
      poNumber: 7,
      projectId: "p1",
      vendorId: "v1",
      acquisitionKind: "Rental",
      hireEndsAt: "2027-06-10T12:00:00.000Z",
      unitPriceMinor: 5000,
      currencyCode: "USD",
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["asset_unit_id", "u1"]]);
    expect(await getAssetUnitProvenance(db, "u2")).toEqual({ ok: true, data: null });
    expect((await getAssetUnitProvenance(db, "u3")).ok).toBe(false);
  });

  it("lists hired-in units of an org", async () => {
    const { db, calls } = fakeClient({
      "from:asset_unit_hire": [
        okResponse([
          {
            asset_unit_id: "u1",
            acquisition_kind: "Rental",
            hire_ends_at: "2027-06-10T12:00:00Z",
            off_hire_due: true,
          },
          { asset_unit_id: null, acquisition_kind: null, hire_ends_at: null, off_hire_due: null },
          {
            asset_unit_id: "u2",
            acquisition_kind: "Purchase",
            hire_ends_at: null,
            off_hire_due: false,
          },
        ]),
      ],
    });
    const hire = await listAssetUnitHire(db, "o1");
    expect(hire.ok && hire.data).toEqual([
      {
        assetUnitId: "u1",
        acquisitionKind: "Rental",
        hireEndsAt: "2027-06-10T12:00:00Z",
        offHireDue: true,
      },
      { assetUnitId: "u2", acquisitionKind: "Purchase", hireEndsAt: null, offHireDue: false },
    ]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["org_id", "o1"]]);
  });

  it("lists where receipt lines came into stock, from their Receipt movements", async () => {
    const { db, calls } = fakeClient({
      "from:asset_lot_movements": [
        okResponse([
          { receipt_line_id: "rl1", lot: { venue_id: "v1" } },
          { receipt_line_id: "rl2", lot: null },
        ]),
        errorResponse("42501", "denied"),
      ],
    });
    expect(await listReceiptStock(db, [])).toEqual({ ok: true, data: [] });
    expect(calls).toHaveLength(0);
    const stock = await listReceiptStock(db, ["rl1", "rl2"]);
    expect(stock.ok && stock.data).toEqual([{ receiptLineId: "rl1", venueId: "v1" }]);
    expect(calls[0]?.steps).toContainEqual(["in", ["receipt_line_id", ["rl1", "rl2"]]]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["movement_kind", "Receipt"]]);
    expect((await listReceiptStock(db, ["rl3"])).ok).toBe(false);
  });
});
