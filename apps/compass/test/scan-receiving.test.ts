import {
  MemoryStore,
  OFFLINE,
  ONLINE,
  SyncEngine,
  type Mutation,
  type UploadOutcome,
} from "@xos/sync";
import { describe, expect, it } from "vitest";
import { access, type CompassIdentity } from "../src/domain/access";
import {
  addScannedTag,
  buildOrderReceipt,
  receivableOrders,
  removeScannedTag,
  setReceiveQuantity,
  startReceiveSheet,
  type ReceivableOrder,
} from "../src/domain/scan";

/**
 * Receive against an order in Compass (R7a): the sheet offers the project's open lines, scanned codes become the
 * serialized line's tags, steppers count the rest, and Submit queues one app.receive_goods mutation whose id is the
 * receipt event id, so it waits out an offline stretch and replays once.
 */

function identity(over: Partial<CompassIdentity>): CompassIdentity {
  return {
    personId: "p",
    displayName: "Field User",
    audience: "field",
    capabilities: [],
    membershipId: "m",
    engagements: [],
    ...over,
  };
}

const ORDER = "po-1";
const RADIOS = "line-radios";
const CABLE = "line-cable";

function order(): ReceivableOrder {
  const [found] = receivableOrders(
    [
      { id: ORDER, po_number: 7, po_state: "Sent", vendor_name: "Delta Rentals" },
      { id: "po-2", po_number: 8, po_state: "Proposed", vendor_name: null },
    ],
    [
      {
        id: RADIOS,
        purchase_order_id: ORDER,
        line_number: 1,
        description: "Radios",
        element_id: "E-RAD",
      },
      {
        id: CABLE,
        purchase_order_id: ORDER,
        line_number: 2,
        description: "Cable",
        element_id: null,
      },
      {
        id: "line-done",
        purchase_order_id: ORDER,
        line_number: 3,
        description: "Done",
        element_id: null,
      },
      {
        id: "line-p2",
        purchase_order_id: "po-2",
        line_number: 1,
        description: "Draft",
        element_id: null,
      },
    ],
    [
      { po_line_id: RADIOS, quantity_ordered: 2, quantity_received: 0 },
      { po_line_id: CABLE, quantity_ordered: 10, quantity_received: 4 },
      { po_line_id: "line-done", quantity_ordered: 1, quantity_received: 1 },
      { po_line_id: "line-p2", quantity_ordered: 1, quantity_received: 0 },
    ],
    ["E-RAD"],
  );
  if (!found) throw new Error("no receivable order");
  return found;
}

describe("Receive against an order", () => {
  it("offers only open lines of approved or sent orders, serialized where the item has a class", () => {
    const o = order();
    expect(o).toMatchObject({ purchaseOrderId: ORDER, poNumber: 7, vendorName: "Delta Rentals" });
    expect(o.lines.map((l) => [l.description, l.open, l.serialized])).toEqual([
      ["Radios", 2, true],
      ["Cable", 6, false],
    ]);
  });

  it("is for internal receivers with procurement.receipt.write; externals never see it", () => {
    const internal = identity({ capabilities: ["procurement.receipt.write"] });
    expect(access(internal, "scan.receiving.order", "proj-1")).toEqual({ allowed: true });
    expect(access(identity({ capabilities: [] }), "scan.receiving.order", "proj-1")).toEqual({
      allowed: false,
      reason: "capability",
    });
    const vendor = identity({
      audience: "vendor",
      membershipId: null,
      engagements: [
        {
          id: "e1",
          orgId: "o1",
          orgName: "Demo Org",
          projectId: "proj-1",
          projectName: "Demo",
          roleType: "vendor",
          state: "Active",
          via: "engagement",
          rosterEntryId: null,
        },
      ],
    });
    expect(access(vendor, "scan.receiving.order", "proj-1")).toEqual({
      allowed: false,
      reason: "role",
    });
  });

  it("fills the tag list from scans and the steppers from taps, within each line's open quantity", () => {
    let sheet = startReceiveSheet(order());
    expect(sheet.activeLineId).toBe(RADIOS);
    sheet = addScannedTag(sheet, " nwl-rad-101 ");
    expect(addScannedTag(sheet, "NWL-RAD-101")).toBe(sheet);
    sheet = addScannedTag(sheet, "NWL-RAD-102");
    expect(addScannedTag(sheet, "NWL-RAD-103")).toBe(sheet);
    expect(sheet.tags[RADIOS]).toEqual(["NWL-RAD-101", "NWL-RAD-102"]);
    sheet = removeScannedTag(sheet, RADIOS, "NWL-RAD-102");
    sheet = addScannedTag(sheet, "NWL-RAD-104");
    sheet = setReceiveQuantity(sheet, CABLE, 9);
    expect(sheet.quantities[CABLE]).toBe(6);
    sheet = setReceiveQuantity(sheet, CABLE, 3);
    expect(setReceiveQuantity(sheet, RADIOS, 1)).toBe(sheet);
    expect(sheet.quantities[CABLE]).toBe(3);
  });

  it("builds one receipt mutation keyed by the event id, and none for an empty sheet", () => {
    const empty = startReceiveSheet(order());
    expect(buildOrderReceipt(empty, null, 0)).toBeNull();
    const sheet = setReceiveQuantity(addScannedTag(empty, "NWL-RAD-101"), CABLE, 2);
    const m = buildOrderReceipt(sheet, " One case dented. ", 1_000, () => "evt-1");
    expect(m).toEqual({
      op: "rpc",
      target: "app.receive_goods",
      table: "goods_receipts",
      rowId: "evt-1",
      payload: {
        p_event_id: "evt-1",
        p_purchase_order_id: ORDER,
        p_lines: [
          { po_line_id: RADIOS, quantity: 1, asset_tags: ["NWL-RAD-101"] },
          { po_line_id: CABLE, quantity: 2 },
        ],
        p_note: "One case dented.",
      },
      policy: "append",
    });
  });

  it("survives going offline: the receipt waits in the outbox and replays once online", async () => {
    const store = new MemoryStore();
    const uploads: Mutation[] = [];
    const uploader = {
      upload: async (mutation: Mutation): Promise<UploadOutcome> => {
        uploads.push(mutation);
        return { kind: "applied" };
      },
    };
    const engine = new SyncEngine({ store, uploader, schedule: () => () => undefined });
    engine.setNetwork(OFFLINE);
    const sheet = addScannedTag(startReceiveSheet(order()), "NWL-RAD-101");
    const mutation = buildOrderReceipt(sheet, null, 5_000, () => "evt-offline");
    if (!mutation) throw new Error("no mutation");
    await engine.outbox.enqueue(mutation);
    expect(uploads).toHaveLength(0);
    expect(await engine.outbox.count()).toBe(1);
    await engine.setNetwork(ONLINE);
    expect(uploads.map((u) => [u.target, u.rowId, u.payload["p_event_id"]])).toEqual([
      ["app.receive_goods", "evt-offline", "evt-offline"],
    ]);
    expect(await engine.outbox.count()).toBe(0);
  });
});
