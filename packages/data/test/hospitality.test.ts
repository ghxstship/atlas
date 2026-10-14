import { describe, expect, it } from "vitest";
import {
  addBeoLine,
  addFulfillmentLine,
  approveBeo,
  assignRoom,
  blockOccupancy,
  createAccommodationBlock,
  createBeo,
  createFulfillment,
  deleteAccommodationBlock,
  deleteBeo,
  deleteFulfillment,
  getAccommodationBlock,
  getBeo,
  getFulfillment,
  lineAmount,
  listAccommodationBlocks,
  listBeos,
  listCurrencyCodes,
  listFulfillmentMoves,
  listFulfillments,
  listFulfillmentTransitions,
  removeBeoLine,
  removeFulfillmentLine,
  removeRoomAssignment,
  restoreBeo,
  restoreFulfillment,
  totalOf,
  transitionFulfillment,
  updateAccommodationBlock,
  updateBeo,
  updateFulfillment,
  type AccommodationBlockInput,
  type FulfillmentInput,
} from "../src/hospitality";
import { errorResponse, fakeClient, okResponse } from "./fake-client";

const project = {
  project_key: "NWL",
  name: "Northwind Summer Series",
  time_zone: "America/New_York",
};
const line = (over: Record<string, unknown> = {}) => ({
  id: "fl1",
  description: "Room Night",
  person_id: "per1",
  quantity: "2",
  unit_price_minor: 18900,
  currency_code: "USD",
  deleted_at: null,
  person: { full_name: "Ivy Marchetti" },
  ...over,
});
const fulfillmentRow = {
  id: "f1",
  fulfillment_number: 4,
  fulfillment_state: "Active",
  project_id: "p1",
  fulfillment_kind: "Lodging",
  title: "Crew Lodging",
  counterparty_id: "c1",
  starts_at: "2027-06-01T20:00:00Z",
  ends_at: "2027-06-04T15:00:00Z",
  created_at: "2027-05-01T00:00:00Z",
  updated_at: "2027-05-02T00:00:00Z",
  project,
  supplier: { counterparty_name: "Harborview Hotel" },
  fulfillment_lines: [
    line(),
    line({ id: "fl2", person_id: "per1", unit_price_minor: null, currency_code: null }),
    line({ id: "fl3", deleted_at: "x" }),
  ],
  beos: [
    { approved_at: "t", deleted_at: null },
    { approved_at: "t", deleted_at: "x" },
  ],
};
const beoRow = {
  id: "b1",
  beo_number: 9,
  project_id: "p1",
  fulfillment_id: "f1",
  event_at: "2027-06-05T22:00:00Z",
  guest_count: 120,
  approved_at: null,
  created_by: "per2",
  created_at: "2027-05-03T00:00:00Z",
  project,
  fulfillment: { title: "Crew Catering" },
  approver: null,
  beo_lines: [
    {
      id: "bl1",
      description: "Plated Dinner",
      quantity: 120,
      unit_price_minor: 4500,
      currency_code: "USD",
      deleted_at: null,
    },
    {
      id: "bl2",
      description: "Coffee",
      quantity: 1,
      unit_price_minor: null,
      currency_code: null,
      deleted_at: null,
    },
  ],
};
const blockRow = {
  id: "ab1",
  block_number: 6,
  project_id: "p1",
  title: "Harborview Crew Block",
  counterparty_id: "c1",
  check_in_on: "2027-06-01",
  check_out_on: "2027-06-04",
  rooms_held: 2,
  release_on: "2027-05-15",
  nightly_rate_minor: 18900,
  currency_code: "USD",
  updated_at: "2027-05-02T00:00:00Z",
  project,
  hotel: { counterparty_name: "Harborview Hotel" },
  accommodation_assignments: [
    {
      id: "a2",
      person_id: "per2",
      check_in_on: "2027-06-02",
      check_out_on: "2027-06-04",
      deleted_at: null,
      person: { full_name: "Bo" },
    },
    {
      id: "a1",
      person_id: "per1",
      check_in_on: "2027-06-01",
      check_out_on: "2027-06-04",
      deleted_at: null,
      person: { full_name: "Ann" },
    },
    {
      id: "a3",
      person_id: "per3",
      check_in_on: "2027-06-01",
      check_out_on: "2027-06-02",
      deleted_at: "x",
      person: null,
    },
  ],
};
const fulfillmentInput: FulfillmentInput = {
  kind: "Catering",
  title: "Crew Catering",
  supplierId: null,
  startsAt: null,
  endsAt: null,
};
const blockInput: AccommodationBlockInput = {
  title: "Harborview Crew Block",
  hotelId: null,
  checkInOn: "2027-06-01",
  checkOutOn: "2027-06-04",
  roomsHeld: 2,
  releaseOn: null,
  nightlyRateMinor: null,
  currencyCode: null,
};

describe("money", () => {
  it("never coerces an unpriced line to zero", () => {
    expect(lineAmount({ quantity: 3, unitPriceMinor: null, currencyCode: null })).toBeNull();
    expect(lineAmount({ quantity: 1.5, unitPriceMinor: 333, currencyCode: "USD" })).toBe(500);
  });

  it("totals priced lines with the unpriced count beside them", () => {
    expect(totalOf([])).toEqual({
      amountMinor: null,
      currencyCode: null,
      unpricedCount: 0,
      mixedCurrencies: false,
    });
    expect(
      totalOf([
        { quantity: 2, unitPriceMinor: 100, currencyCode: "USD" },
        { quantity: 1, unitPriceMinor: null, currencyCode: null },
      ]),
    ).toEqual({ amountMinor: 200, currencyCode: "USD", unpricedCount: 1, mixedCurrencies: false });
    expect(
      totalOf([
        { quantity: 1, unitPriceMinor: 100, currencyCode: "USD" },
        { quantity: 1, unitPriceMinor: 100, currencyCode: "EUR" },
      ]),
    ).toMatchObject({ amountMinor: null, mixedCurrencies: true });
    expect(totalOf([{ quantity: 1, unitPriceMinor: null, currencyCode: null }])).toMatchObject({
      amountMinor: null,
      unpricedCount: 1,
    });
  });
});

describe("fulfillments", () => {
  it("lists fulfillments with key, state, guests and a NULL-aware total", async () => {
    const { db, calls } = fakeClient({ "from:fulfillments": [okResponse([fulfillmentRow])] });
    const result = await listFulfillments(db, { orgId: "o1", projectId: "p1", kind: "Lodging" });
    expect(result.ok && result.data[0]).toMatchObject({
      key: "NWL-4",
      state: "Active",
      supplierName: "Harborview Hotel",
      guestCount: 1,
      lineCount: 2,
      approvedBeoCount: 1,
      total: { amountMinor: 37800, currencyCode: "USD", unpricedCount: 1 },
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["fulfillment_kind", "Lodging"]]);
  });

  it("reads one fulfillment with lines and BEOs", async () => {
    const { db } = fakeClient({
      "from:fulfillments": [
        okResponse(fulfillmentRow),
        okResponse(null),
        errorResponse("XX000", "down"),
      ],
      "from:beos": [okResponse([beoRow]), errorResponse("XX000", "down")],
    });
    const result = await getFulfillment(db, "f1");
    expect(result.ok && result.data.lines.map((l) => l.id)).toEqual(["fl1", "fl2"]);
    expect(result.ok && result.data.lines[0]?.personName).toBe("Ivy Marchetti");
    expect(result.ok && result.data.beos[0]?.key).toBe("NWL-9");
    expect(await getFulfillment(db, "f1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await getFulfillment(db, "f1")).ok).toBe(false);
    const beoFail = fakeClient({
      "from:fulfillments": [okResponse(fulfillmentRow)],
      "from:beos": [errorResponse("XX000", "down")],
    });
    expect((await getFulfillment(beoFail.db, "f1")).ok).toBe(false);
    const listFail = fakeClient({ "from:fulfillments": [errorResponse("XX000", "down")] });
    expect((await listFulfillments(listFail.db, { orgId: "o1" })).ok).toBe(false);
  });

  it("creates, edits with a version check, deletes and restores", async () => {
    const { db } = fakeClient({
      "from:fulfillments": [
        okResponse([{ id: "f9" }]),
        errorResponse("42501", "no"),
        okResponse([{ id: "f9" }]),
        okResponse([]),
        okResponse([]),
        errorResponse("XX000", "down"),
        okResponse([{ id: "f9" }]),
        okResponse([{ id: "f9" }]),
      ],
    });
    expect(await createFulfillment(db, "p1", fulfillmentInput)).toEqual({
      ok: true,
      data: { id: "f9" },
    });
    expect((await createFulfillment(db, "p1", fulfillmentInput)).ok).toBe(false);
    expect((await updateFulfillment(db, "f9", fulfillmentInput, "v")).ok).toBe(true);
    expect(await updateFulfillment(db, "f9", fulfillmentInput, "v")).toEqual({
      ok: false,
      error: { kind: "conflict", message: "fulfillment_changed" },
    });
    expect(await updateFulfillment(db, "f9", fulfillmentInput)).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await updateFulfillment(db, "f9", fulfillmentInput)).ok).toBe(false);
    expect((await deleteFulfillment(db, "f9")).ok).toBe(true);
    expect((await restoreFulfillment(db, "f9")).ok).toBe(true);
  });

  it("transitions through the RPC and reads moves and the ledger", async () => {
    const { db, calls } = fakeClient({
      "rpc:transition_fulfillment": [
        okResponse("ledger-id"),
        errorResponse(
          "XR001",
          "fulfillment_state_conflict: The fulfillment is not in the expected state Active.",
        ),
      ],
      "from:lifecycle_transition_rules": [
        okResponse([{ to_state: "Canceled" }, { to_state: "Active" }]),
        errorResponse("XX000", "down"),
      ],
      "from:fulfillment_state_transitions": [
        okResponse([
          {
            id: "t1",
            from_state: "Proposed",
            to_state: "Active",
            reason: "Confirmed.",
            created_at: "t",
            author: { full_name: "Dana" },
          },
          {
            id: "t0",
            from_state: null,
            to_state: "Proposed",
            reason: "Created.",
            created_at: "t",
            author: null,
          },
        ]),
        errorResponse("XX000", "down"),
      ],
    });
    expect(await transitionFulfillment(db, "f1", "Proposed", "Active", "Confirmed.")).toEqual({
      ok: true,
      data: null,
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [
        {
          p_fulfillment_id: "f1",
          p_expected: "Proposed",
          p_next: "Active",
          p_reason: "Confirmed.",
        },
      ],
    ]);
    const conflict = await transitionFulfillment(db, "f1", "Active", "Complete", "Done.");
    expect(conflict.ok === false && conflict.error.kind).toBe("refusal");
    expect(await listFulfillmentMoves(db, "Proposed")).toEqual({
      ok: true,
      data: ["Active", "Canceled"],
    });
    expect((await listFulfillmentMoves(db, "Proposed")).ok).toBe(false);
    const ledger = await listFulfillmentTransitions(db, "f1");
    expect(ledger.ok && ledger.data[0]?.byName).toBe("Dana");
    expect(ledger.ok && ledger.data[1]?.fromState).toBeNull();
    expect((await listFulfillmentTransitions(db, "f1")).ok).toBe(false);
  });

  it("adds and removes lines; a closed fulfillment refuses them", async () => {
    const lineInput = {
      description: "Room Night",
      personId: "per1",
      quantity: 3,
      unitPriceMinor: null,
      currencyCode: null,
    };
    const { db } = fakeClient({
      "from:fulfillment_lines": [
        okResponse([{ id: "fl9" }]),
        errorResponse(
          "XR001",
          "fulfillment_closed: A Complete fulfillment's lines no longer change; reopen it first.",
        ),
        okResponse([{ id: "fl9" }]),
      ],
    });
    expect((await addFulfillmentLine(db, "f1", lineInput)).ok).toBe(true);
    const refused = await addFulfillmentLine(db, "f1", lineInput);
    expect(refused.ok === false && refused.error.kind === "refusal" && refused.error.rule).toBe(
      "fulfillment_closed",
    );
    expect((await removeFulfillmentLine(db, "fl9")).ok).toBe(true);
  });
});

describe("BEOs", () => {
  it("lists and reads BEOs with keys and totals", async () => {
    const { db } = fakeClient({
      "from:beos": [
        okResponse([beoRow]),
        okResponse(beoRow),
        okResponse(null),
        errorResponse("XX000", "down"),
        errorResponse("XX000", "down"),
      ],
    });
    const list = await listBeos(db, { orgId: "o1", projectId: "p1" });
    expect(list.ok && list.data[0]).toMatchObject({
      key: "NWL-9",
      fulfillmentTitle: "Crew Catering",
      total: { amountMinor: 540000, unpricedCount: 1 },
    });
    const one = await getBeo(db, "b1");
    expect(one.ok && one.data.lines.map((l) => l.amountMinor)).toEqual([540000, null]);
    expect(await getBeo(db, "b1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await getBeo(db, "b1")).ok).toBe(false);
    expect((await listBeos(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("creates, edits, approves, deletes and restores", async () => {
    const beoInput = { fulfillmentId: "f1", eventAt: "2027-06-05T22:00:00Z", guestCount: 120 };
    const { db, calls } = fakeClient({
      "from:beos": [
        okResponse([{ id: "b9" }]),
        errorResponse("42501", "no"),
        okResponse([{ id: "b9" }]),
        okResponse([]),
        errorResponse("XX000", "down"),
        okResponse([{ id: "b9" }]),
        errorResponse(
          "XR001",
          "sod_approval_requester: An approval is decided by an eligible approver, never the requester.",
        ),
        okResponse([]),
        okResponse([{ id: "b9" }]),
        okResponse([{ id: "b9" }]),
      ],
    });
    expect((await createBeo(db, "p1", beoInput)).ok).toBe(true);
    expect((await createBeo(db, "p1", beoInput)).ok).toBe(false);
    expect((await updateBeo(db, "b9", beoInput)).ok).toBe(true);
    expect((await updateBeo(db, "b9", beoInput)).ok).toBe(false);
    expect((await updateBeo(db, "b9", beoInput)).ok).toBe(false);
    expect(await approveBeo(db, "b9")).toEqual({ ok: true, data: null });
    const sod = await approveBeo(db, "b9");
    expect(sod.ok === false && sod.error.kind === "refusal" && sod.error.rule).toBe(
      "sod_approval_requester",
    );
    expect(await approveBeo(db, "b9")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await deleteBeo(db, "b9")).ok).toBe(true);
    expect((await restoreBeo(db, "b9")).ok).toBe(true);
    expect(calls[5]?.steps).toContainEqual(["is", ["approved_at", null]]);
  });

  it("adds and removes BEO lines", async () => {
    const { db } = fakeClient({
      "from:beo_lines": [
        okResponse([{ id: "bl9" }]),
        errorResponse("23514", "price"),
        okResponse([{ id: "bl9" }]),
      ],
    });
    const input = {
      description: "Plated Dinner",
      quantity: 120,
      unitPriceMinor: 4500,
      currencyCode: "USD",
    };
    expect((await addBeoLine(db, "b1", input)).ok).toBe(true);
    expect((await addBeoLine(db, "b1", { ...input, currencyCode: null })).ok).toBe(false);
    expect((await removeBeoLine(db, "bl9")).ok).toBe(true);
  });

  it("lists currency codes", async () => {
    const { db } = fakeClient({
      "from:currencies": [
        okResponse([{ currency_code: "EUR" }, { currency_code: "USD" }]),
        errorResponse("XX000", "down"),
      ],
    });
    expect(await listCurrencyCodes(db)).toEqual({ ok: true, data: ["EUR", "USD"] });
    expect((await listCurrencyCodes(db)).ok).toBe(false);
  });
});

describe("accommodation blocks", () => {
  it("derives nightly occupancy", () => {
    const occupancy = blockOccupancy("2027-06-01", "2027-06-04", 2, [
      { checkInOn: "2027-06-01", checkOutOn: "2027-06-04" },
      { checkInOn: "2027-06-02", checkOutOn: "2027-06-04" },
    ]);
    expect(occupancy).toEqual({
      nights: 3,
      roomNightsHeld: 6,
      roomNightsAssigned: 5,
      peakAssigned: 2,
      byNight: [
        { night: "2027-06-01", assigned: 1 },
        { night: "2027-06-02", assigned: 2 },
        { night: "2027-06-03", assigned: 2 },
      ],
    });
    expect(blockOccupancy("2027-06-04", "2027-06-01", 1, []).nights).toBe(0);
  });

  it("lists and reads blocks with live assignments and the contract total", async () => {
    const { db, calls } = fakeClient({
      "from:accommodation_blocks": [
        okResponse([blockRow]),
        okResponse(blockRow),
        okResponse(null),
        errorResponse("XX000", "down"),
        errorResponse("XX000", "down"),
      ],
    });
    const list = await listAccommodationBlocks(db, { orgId: "o1", projectId: "p1" });
    expect(list.ok && list.data[0]).toMatchObject({
      key: "NWL-6",
      hotelName: "Harborview Hotel",
      occupancy: { roomNightsHeld: 6, roomNightsAssigned: 5 },
      contractTotal: { amountMinor: 113400, currencyCode: "USD", unpricedCount: 0 },
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["project_id", "p1"]]);
    const one = await getAccommodationBlock(db, "ab1");
    expect(one.ok && one.data.assignments.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(await getAccommodationBlock(db, "ab1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await getAccommodationBlock(db, "ab1")).ok).toBe(false);
    expect((await listAccommodationBlocks(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("shows an unpriced block's total as unpriced", async () => {
    const { db } = fakeClient({
      "from:accommodation_blocks": [
        okResponse([{ ...blockRow, nightly_rate_minor: null, currency_code: null, hotel: null }]),
      ],
    });
    const list = await listAccommodationBlocks(db, { orgId: "o1" });
    expect(list.ok && list.data[0]?.contractTotal).toMatchObject({
      amountMinor: null,
      unpricedCount: 1,
    });
  });

  it("creates, edits, deletes and restores blocks", async () => {
    const { db } = fakeClient({
      "from:accommodation_blocks": [
        okResponse([{ id: "ab9" }]),
        errorResponse("42501", "no"),
        okResponse([{ id: "ab9" }]),
        okResponse([]),
        okResponse([]),
        errorResponse(
          "XR001",
          "accommodation_block_full: More rooms are assigned on some night than the block would hold.",
        ),
        okResponse([{ id: "ab9" }]),
        okResponse([{ id: "ab9" }]),
        okResponse([]),
        errorResponse("XX000", "down"),
      ],
    });
    expect((await createAccommodationBlock(db, "p1", blockInput)).ok).toBe(true);
    expect((await createAccommodationBlock(db, "p1", blockInput)).ok).toBe(false);
    expect((await updateAccommodationBlock(db, "ab9", blockInput, "v")).ok).toBe(true);
    expect(await updateAccommodationBlock(db, "ab9", blockInput, "v")).toEqual({
      ok: false,
      error: { kind: "conflict", message: "accommodation_block_changed" },
    });
    expect(await updateAccommodationBlock(db, "ab9", blockInput)).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    const full = await updateAccommodationBlock(db, "ab9", { ...blockInput, roomsHeld: 1 });
    expect(full.ok === false && full.error.kind === "refusal" && full.error.rule).toBe(
      "accommodation_block_full",
    );
    expect((await deleteAccommodationBlock(db, "ab9")).ok).toBe(true);
    expect((await deleteAccommodationBlock(db, "ab9", false)).ok).toBe(true);
    expect((await deleteAccommodationBlock(db, "ab9")).ok).toBe(false);
    expect((await deleteAccommodationBlock(db, "ab9")).ok).toBe(false);
  });

  it("assigns and removes rooms; a full block refuses", async () => {
    const stay = { personId: "per1", checkInOn: "2027-06-01", checkOutOn: "2027-06-02" };
    const { db } = fakeClient({
      "from:accommodation_assignments": [
        okResponse([{ id: "a9" }]),
        errorResponse(
          "XR001",
          "accommodation_block_full: Every one of the 2 rooms is assigned on at least one of those nights.",
        ),
        okResponse([{ id: "a9" }]),
        okResponse([]),
        errorResponse("XX000", "down"),
      ],
    });
    expect((await assignRoom(db, "ab1", stay)).ok).toBe(true);
    const full = await assignRoom(db, "ab1", stay);
    expect(full.ok === false && full.error.kind === "refusal" && full.error.rule).toBe(
      "accommodation_block_full",
    );
    expect((await removeRoomAssignment(db, "a9")).ok).toBe(true);
    expect((await removeRoomAssignment(db, "a9")).ok).toBe(false);
    expect((await removeRoomAssignment(db, "a9")).ok).toBe(false);
  });
});
