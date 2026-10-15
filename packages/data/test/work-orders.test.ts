import { describe, expect, it } from "vitest";
import {
  addBid,
  awardWorkOrder,
  createPunchItem,
  createWorkOrder,
  deleteWorkOrder,
  getPunchItemForRecord,
  getWorkOrder,
  listBidderOptions,
  listPunchItems,
  listWorkOrders,
  listWorkOrderTransitions,
  summarizeBids,
  transitionWorkOrder,
  updateBid,
  updateWorkOrder,
  type Bid,
} from "../src/work-orders.ts";
import { errorResponse, okResponse } from "./fake-client.ts";
import { moduleClient, stepsOf } from "./module-client.ts";
import { recordRow } from "./records-fixture.ts";

const bidRow = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  work_order_id: "w1",
  bidder_organization_id: "org9",
  bidder_person_id: null,
  amount_minor: "1250000",
  currency_code: "USD",
  estimated_hours: "12.5",
  note: null,
  submitted_at: "2027-05-02T00:00:00Z",
  withdrawn_at: null,
  deleted_at: null,
  organization: { name: "Zeta Rigging" },
  person: null,
  ...over,
});

const woRow = (over: Record<string, unknown> = {}) => ({
  id: "w1",
  work_order_number: 3,
  project_id: "p1",
  scope_node_id: null,
  record_id: null,
  title: "Rig the Main Stage Truss",
  scope_of_work: null,
  urid: null,
  location_text: null,
  scheduled_starts_at: null,
  scheduled_ends_at: null,
  estimated_hours: null,
  bid_due_at: null,
  awarded_bid_id: null,
  work_order_state: "Open",
  created_by: "pe1",
  created_at: "t",
  updated_at: "t",
  project: { project_key: "NWL", name: "Series", time_zone: "America/New_York" },
  bids: [
    bidRow({
      id: "b2",
      submitted_at: "2027-05-03T00:00:00Z",
      amount_minor: null,
      organization: null,
      person: { full_name: "Lee" },
    }),
    bidRow(),
    bidRow({ id: "b3", deleted_at: "t" }),
  ],
  ...over,
});

const bid = (over: Partial<Bid> = {}): Bid => ({
  id: "b",
  workOrderId: "w1",
  bidderOrganizationId: "o",
  bidderPersonId: null,
  bidderName: null,
  amountMinor: 100,
  currencyCode: "USD",
  estimatedHours: null,
  note: null,
  submittedAt: "t",
  withdrawnAt: null,
  ...over,
});

describe("work orders", () => {
  it("lists work orders with keys and live bids in submission order", async () => {
    const { db, calls } = moduleClient({
      "from:work_orders": [
        okResponse([woRow(), woRow({ id: "w2", project: null, bids: null })]),
        errorResponse("XX000", "b"),
      ],
    });
    const list = await listWorkOrders(db, {
      orgId: "o1",
      projectId: "p1",
      states: ["Open"],
      search: "truss",
    });
    expect(list.ok && list.data[0]?.key).toBe("NWL-WO-3");
    expect(list.ok && list.data[0]?.bids.map((b) => [b.id, b.amountMinor, b.bidderName])).toEqual([
      ["b1", 1_250_000, "Zeta Rigging"],
      ["b2", null, "Lee"],
    ]);
    expect(list.ok && list.data[1]).toMatchObject({ key: "-WO-3", timeZone: "UTC", bids: [] });
    expect(stepsOf(calls[0], "in")).toEqual([["work_order_state", ["Open"]]]);
    expect(stepsOf(calls[0], "ilike")).toEqual([["title", "%truss%"]]);
    expect((await listWorkOrders(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("reads one work order and the lifecycle rules", async () => {
    const { db } = moduleClient({
      "from:work_orders": [
        okResponse(woRow({ estimated_hours: "8" })),
        okResponse(null),
        errorResponse("XX000", "b"),
      ],
      "from:lifecycle_transition_rules": [
        okResponse([
          { from_state: "Draft", to_state: "Open" },
          { from_state: null, to_state: "Open" },
        ]),
        errorResponse("XX000", "b"),
      ],
    });
    const one = await getWorkOrder(db, "w1");
    expect(one.ok && one.data.estimatedHours).toBe(8);
    expect(await getWorkOrder(db, "w1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await getWorkOrder(db, "w1")).ok).toBe(false);
    expect(await listWorkOrderTransitions(db)).toEqual({
      ok: true,
      data: [{ from: "Draft", to: "Open" }],
    });
    expect((await listWorkOrderTransitions(db)).ok).toBe(false);
  });

  it("creates, edits and deletes work orders", async () => {
    const { db, calls } = moduleClient({
      "from:work_orders": [
        okResponse({ id: "w9", work_order_number: 4 }),
        errorResponse("XX000", "b"),
        okResponse([{ id: "w9" }]),
        okResponse([]),
        errorResponse("XX000", "b"),
        okResponse([{ id: "w9" }]),
        okResponse([]),
        errorResponse("XR001", "work_order_retained: draft only", "work_order_retained"),
      ],
    });
    expect(
      await createWorkOrder(db, {
        orgId: "o1",
        projectId: "p1",
        title: " Rig the truss ",
        scopeOfWork: "  ",
        scopeNodeId: "s1",
        recordId: "r1",
        urid: "5000.01.01",
        locationText: " Stage left ",
        scheduledStartsAt: "a",
        scheduledEndsAt: "b",
        estimatedHours: 6,
        bidDueAt: "c",
      }),
    ).toEqual({ ok: true, data: { id: "w9", number: 4 } });
    expect(stepsOf(calls[0], "insert")[0]?.[0]).toMatchObject({
      title: "Rig the truss",
      scope_of_work: null,
      location_text: "Stage left",
      estimated_hours: 6,
    });
    expect((await createWorkOrder(db, { orgId: "o1", projectId: "p1", title: "x" })).ok).toBe(
      false,
    );
    expect((await updateWorkOrder(db, "w9", { title: "Rig" })).ok).toBe(true);
    expect(await updateWorkOrder(db, "w9", { scopeOfWork: null, locationText: null })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await updateWorkOrder(db, "w9", { title: "x" })).ok).toBe(false);
    expect(await updateWorkOrder(db, "w9", {})).toEqual({ ok: true, data: null });
    expect((await deleteWorkOrder(db, "w9")).ok).toBe(true);
    expect(await deleteWorkOrder(db, "w9")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await deleteWorkOrder(db, "w9")).ok).toBe(false);
  });

  it("transitions and awards through the RPCs", async () => {
    const { db, calls } = moduleClient({
      "rpc:transition_work_order": [
        okResponse("e1"),
        errorResponse("XR001", "work_order_award_rpc_only: rpc", "work_order_award_rpc_only"),
      ],
      "rpc:award_work_order": [
        okResponse("e2"),
        errorResponse("XR001", "sod_work_order_award: other person", "sod_work_order_award"),
      ],
    });
    expect(
      (
        await transitionWorkOrder(db, {
          id: "w1",
          expected: "Draft",
          next: "Open",
          reason: "Bids invited.",
        })
      ).ok,
    ).toBe(true);
    expect(stepsOf(calls[0], "args")[0]?.[0]).toEqual({
      p_work_order_id: "w1",
      p_expected: "Draft",
      p_next: "Open",
      p_reason: "Bids invited.",
    });
    expect(
      (await transitionWorkOrder(db, { id: "w1", expected: "Open", next: "Awarded", reason: "x" }))
        .ok,
    ).toBe(false);
    expect((await awardWorkOrder(db, { id: "w1", bidId: "b1", reason: "Lowest." })).ok).toBe(true);
    expect(await awardWorkOrder(db, { id: "w1", bidId: "b1", reason: "Lowest." })).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "sod_work_order_award", message: "other person" },
    });
  });
});

describe("bids", () => {
  it("records, edits and withdraws bids", async () => {
    const { db, calls } = moduleClient({
      "from:work_order_bids": [
        okResponse({ id: "b9" }),
        errorResponse("XR001", "bid_window_closed: closed", "bid_window_closed"),
        okResponse([{ id: "b9" }]),
        okResponse([]),
        errorResponse("XX000", "b"),
      ],
    });
    expect(
      await addBid(db, {
        orgId: "o1",
        workOrderId: "w1",
        bidderOrganizationId: "org9",
        amountMinor: null,
        currencyCode: "USD",
        note: " Site walk first. ",
      }),
    ).toEqual({ ok: true, data: { id: "b9" } });
    expect(stepsOf(calls[0], "insert")[0]?.[0]).toMatchObject({
      amount_minor: null,
      bidder_person_id: null,
      note: "Site walk first.",
    });
    expect(
      (
        await addBid(db, {
          orgId: "o1",
          workOrderId: "w1",
          bidderPersonId: "pe1",
          amountMinor: 5,
          currencyCode: "USD",
        })
      ).ok,
    ).toBe(false);
    expect((await updateBid(db, "b9", { amountMinor: 900, note: null, withdraw: true })).ok).toBe(
      true,
    );
    expect(stepsOf(calls[2], "update")[0]?.[0]).toMatchObject({ amount_minor: 900, note: null });
    expect(await updateBid(db, "b9", {})).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await updateBid(db, "b9", {})).ok).toBe(false);
  });

  it("summarizes live bids without coercing unpriced to zero", () => {
    const summary = summarizeBids([
      bid({ id: "a", amountMinor: 500 }),
      bid({ id: "b", amountMinor: 300 }),
      bid({ id: "c", amountMinor: null }),
      bid({ id: "d", amountMinor: 100, withdrawnAt: "t" }),
      bid({ id: "e", amountMinor: 900, currencyCode: "EUR" }),
    ]);
    expect(summary).toMatchObject({ live: 4, priced: 3, unpriced: 1 });
    expect([...summary.lowest]).toEqual([
      ["USD", 300],
      ["EUR", 900],
    ]);
    expect(summarizeBids([bid({ amountMinor: null })]).lowest.size).toBe(0);
  });

  it("lists bidders from counterparties by name", async () => {
    const { db } = moduleClient({
      "from:counterparties": [
        okResponse([
          { organization_id: "o3", organization: { name: "Zeta" } },
          { organization_id: "o2", organization: null },
        ]),
        errorResponse("XX000", "b"),
      ],
    });
    const list = await listBidderOptions(db, "o1");
    expect(list.ok && list.data.map((b) => b.name)).toEqual(["o2", "Zeta"]);
    expect((await listBidderOptions(db, "o1")).ok).toBe(false);
  });
});

describe("punch items", () => {
  const punch = (over: Record<string, unknown> = {}) => ({
    id: "pi1",
    record_id: "r1",
    source_record_id: null,
    inspection_result_id: null,
    zone_id: "z1",
    site_plan_pin_id: null,
    location_text: "Stair 2",
    zone: { name: "Backstage" },
    ...over,
  });

  it("lists punch items with their Task records", async () => {
    const { db, calls } = moduleClient({
      "from:punch_items": [
        okResponse([
          punch({ id: "pi2", record_id: "r2", zone: null }),
          punch(),
          punch({ id: "pi3", record_id: "gone" }),
        ]),
        okResponse([]),
        errorResponse("XX000", "b"),
        okResponse([punch()]),
      ],
      "from:records": [
        okResponse([recordRow({ id: "r2", record_number: 9 }), recordRow()]),
        errorResponse("XX000", "b"),
      ],
    });
    const list = await listPunchItems(db, { orgId: "o1", projectId: "p1", states: ["Proposed"] });
    expect(list.ok && list.data.map((p) => [p.id, p.zoneName])).toEqual([
      ["pi1", "Backstage"],
      ["pi2", null],
    ]);
    expect(stepsOf(calls[1], "in")).toContainEqual(["record_state", ["Proposed"]]);
    expect(await listPunchItems(db, { orgId: "o1" })).toEqual({ ok: true, data: [] });
    expect((await listPunchItems(db, { orgId: "o1" })).ok).toBe(false);
    expect((await listPunchItems(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("reads a record's punch facts and raises items", async () => {
    const { db, calls } = moduleClient({
      "from:punch_items": [okResponse(punch()), okResponse(null), errorResponse("XX000", "b")],
      "rpc:create_punch_item": [okResponse("pi9"), errorResponse("42501", "denied")],
    });
    expect(await getPunchItemForRecord(db, "r1")).toEqual({
      ok: true,
      data: { id: "pi1", sourceRecordId: null, locationText: "Stair 2" },
    });
    expect(await getPunchItemForRecord(db, "r1")).toEqual({ ok: true, data: null });
    expect((await getPunchItemForRecord(db, "r1")).ok).toBe(false);
    expect(
      await createPunchItem(db, {
        projectId: "p1",
        what: "Loose handrail",
        locationText: "Stair 2",
      }),
    ).toEqual({
      ok: true,
      data: { id: "pi9" },
    });
    expect(stepsOf(calls[3], "args")[0]?.[0]).toMatchObject({
      p_what: "Loose handrail",
      p_zone_id: null,
      p_owner_party_id: null,
    });
    expect(await createPunchItem(db, { projectId: "p1", what: "x" })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });
});
