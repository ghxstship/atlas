import { describe, expect, it } from "vitest";
import {
  ALLOCATION_DISPLAY_STATUSES,
  type Allocation,
  type AllocationHolder,
} from "@xos/data/allocations";
import {
  ALLOCATION_RECORD_STATE,
  allocationActions,
  allocationBulkConfig,
  allocationMatrix,
  copyKey,
  groupByStatus,
  holderOf,
  partyOf,
  STATUS_ORDER,
  visibleAllocations,
} from "@/lib/advancing/allocations";

const allocation = (over: Partial<Allocation>): Allocation => ({
  id: "a",
  projectId: "p1",
  holderEngagementId: null,
  rosterEntryId: "kai",
  parentAllocationId: null,
  kind: "Asset",
  offering: "Radios",
  itemName: "Two-way radios",
  quantity: 2,
  state: "Approved",
  origin: "Assigned",
  neededFrom: null,
  neededTo: null,
  timeZone: "UTC",
  requestedBy: null,
  decidedAt: null,
  decidedBy: null,
  declineReason: null,
  reservedQuantity: 2,
  onOrderQuantity: 0,
  confirmed: false,
  awaitingOrder: false,
  receivedQuantity: 0,
  issuedQuantity: 0,
  returnedQuantity: 0,
  lostQuantity: 0,
  revokedQuantity: 0,
  status: "Reserved",
  ...over,
});

const holders: AllocationHolder[] = [
  {
    kind: "Pool",
    engagementId: "e1",
    rosterEntryId: null,
    projectId: "p1",
    holderName: "Bayside Audio",
    partyName: "Bayside Audio",
    roleType: "Vendor",
    entryState: null,
    personResponse: null,
    roleCode: null,
  },
  {
    kind: "Person",
    engagementId: "e1",
    rosterEntryId: "kai",
    projectId: "p1",
    holderName: "Kai Morgan",
    partyName: "Bayside Audio",
    roleType: "Vendor",
    entryState: "Accepted",
    personResponse: "Accepted",
    roleCode: "9000.50.02",
  },
  {
    kind: "Person",
    engagementId: "e2",
    rosterEntryId: "ivy",
    projectId: "p1",
    holderName: "Ivy Marchetti",
    partyName: "Ivy Marchetti",
    roleType: "Crew",
    entryState: "Accepted",
    personResponse: "Accepted",
    roleCode: null,
  },
];

describe("allocations in Atlas", () => {
  it("gives every computed status a chip and a place in the list", () => {
    for (const status of ALLOCATION_DISPLAY_STATUSES) {
      expect(ALLOCATION_RECORD_STATE[status], status).toBeTruthy();
    }
    expect([...STATUS_ORDER].sort()).toEqual([...ALLOCATION_DISPLAY_STATUSES].sort());
    expect(ALLOCATION_RECORD_STATE.Requested).toBe("in-review");
    expect(ALLOCATION_RECORD_STATE.Returned).toBe("complete");
    expect(copyKey("Partly Issued")).toBe("partly_issued");
    expect(copyKey("Parking Pass")).toBe("parking_pass");
  });

  it("names holders and parties, a pool by its party", () => {
    expect(holderOf(allocation({}), holders)).toBe("Kai Morgan");
    const pool = allocation({ rosterEntryId: null, holderEngagementId: "e1" });
    expect(holderOf(pool, holders)).toBe("Bayside Audio");
    expect(partyOf(allocation({ rosterEntryId: "ivy" }), holders)).toBe("Ivy Marchetti");
  });

  it("filters by kind, status, party and conflicts, hiding withdrawn and declined unless asked", () => {
    const rows = [
      allocation({ id: "a1" }),
      allocation({ id: "a2", kind: "Credential", status: "Requested", state: "Requested" }),
      allocation({ id: "a3", status: "Withdrawn", state: "Withdrawn" }),
      allocation({ id: "a4", rosterEntryId: "ivy", kind: "Travel", status: "Approved" }),
    ];
    expect(visibleAllocations(rows, holders, {}).map((a) => a.id)).toEqual(["a1", "a2", "a4"]);
    expect(visibleAllocations(rows, holders, { status: "Withdrawn" }).map((a) => a.id)).toEqual([
      "a3",
    ]);
    expect(visibleAllocations(rows, holders, { kind: "Credential" }).map((a) => a.id)).toEqual([
      "a2",
    ]);
    expect(visibleAllocations(rows, holders, { party: "Ivy Marchetti" }).map((a) => a.id)).toEqual([
      "a4",
    ]);
    expect(
      visibleAllocations(rows, holders, { conflicts: new Set(["a1"]) }).map((a) => a.id),
    ).toEqual(["a1"]);
  });

  it("groups by status, decisions first", () => {
    const groups = groupByStatus([
      allocation({ id: "a1", status: "Issued" }),
      allocation({ id: "a2", status: "Requested" }),
      allocation({ id: "a3", status: "Issued" }),
    ]);
    expect(groups.map((g) => [g.status, g.rows.map((r) => r.id)])).toEqual([
      ["Requested", ["a2"]],
      ["Issued", ["a1", "a3"]],
    ]);
  });

  it("builds the people by kind matrix, the leading status per cell, pools left out", () => {
    const m = allocationMatrix(
      [
        allocation({ id: "a1", quantity: 1, status: "Issued" }),
        allocation({ id: "a2", quantity: 1, status: "Requested" }),
        allocation({ id: "a3", kind: "Credential", quantity: 1, status: "Issued" }),
        allocation({
          id: "a4",
          rosterEntryId: "ivy",
          kind: "Travel",
          quantity: 1,
          status: "Approved",
        }),
        allocation({ id: "pool", rosterEntryId: null, holderEngagementId: "e1", quantity: 4 }),
      ],
      holders,
    );
    expect(m.kinds).toEqual(["Credential", "Asset", "Travel"]);
    expect(m.people.map((p) => p.name)).toEqual(["Kai Morgan", "Ivy Marchetti"]);
    expect(m.people[0]?.cells.Asset).toEqual({
      quantity: 2,
      status: "Requested",
      ids: ["a1", "a2"],
    });
    expect(m.people[1]?.cells.Asset).toBeUndefined();
  });

  it("offers bulk decisions only to reviewers", () => {
    const labels = { state: "Decision", approve: "Approve", decline: "Decline" };
    expect(allocationBulkConfig("nwl", false, labels)).toBeNull();
    expect(allocationBulkConfig("nwl", true, labels)).toEqual({
      org: "nwl",
      resource: "advance_allocations",
      fields: [
        {
          key: "allocation_state",
          label: "Decision",
          reason: true,
          options: [
            { value: "Approved", label: "Approve" },
            { value: "Declined", label: "Decline" },
          ],
        },
      ],
    });
  });

  it("offers the actions a row's state, kind and the viewer allow", () => {
    const both = { write: true, review: true };
    expect(
      allocationActions(allocation({ state: "Requested", status: "Requested" }), both),
    ).toEqual(["review", "withdraw"]);
    expect(
      allocationActions(allocation({ state: "Requested", status: "Requested" }), {
        write: false,
        review: false,
      }),
    ).toEqual([]);
    const pool = allocation({ rosterEntryId: null, holderEngagementId: "e1", quantity: 6 });
    expect(allocationActions(pool, both)).toEqual(["split", "issue", "withdraw"]);
    expect(
      allocationActions(
        allocation({ kind: "Credential", rosterEntryId: null, holderEngagementId: "e1" }),
        both,
      ),
    ).toEqual(["split", "withdraw"]);
    expect(
      allocationActions(allocation({ origin: "Split", parentAllocationId: "pool" }), both),
    ).toEqual(["unsplit", "issue", "withdraw"]);
    expect(allocationActions(allocation({ issuedQuantity: 2 }), both)).toEqual(["withdraw"]);
  });
});
