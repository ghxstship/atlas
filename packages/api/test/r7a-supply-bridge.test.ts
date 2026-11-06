/**
 * Contract tests for R7a's supply bridge (RRR-183, migrations 2681 to 2683): receiving and returning against a
 * purchase order, the goods returns read back, rental lines with their hire period, the window warnings of rental
 * lines (G-99) and the hired-in units (G-96). Requests run through `contractApp` against the in-memory client and
 * every success is checked against openapi/v1.json with `expectContract`.
 */
import { describe, expect, it } from "vitest";
import { handlers as assets } from "../src/handlers/assets.ts";
import { handlers as procurement } from "../src/handlers/procurement.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { MemoryDb, Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const ME = testContext().personId as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(27000 + n).padStart(12, "0")}`;
const PROJECT = id(1);
const VENDOR = id(2);
const PO = id(3);
const PO_LINE = id(4);
const RECEIPT_LINE = id(6);
const RETURN = id(7);
const RETURN_LINE = id(8);
const UNIT = id(9);
const HIRE = '["2027-06-01 12:00:00+00","2027-06-05 12:00:00+00")';
const SITE = '["2027-05-31 08:00:00+00","2027-06-06 00:00:00+00")';

function world() {
  const db: MemoryDb = memoryDb(
    {
      purchase_orders: [
        tenantRow(PO, ORG, {
          project_id: PROJECT,
          po_number: 7,
          vendor_id: VENDOR,
          rfq_response_id: null,
          currency_code: "USD",
          po_state: "Sent",
        }),
      ],
      po_lines: [
        tenantRow(PO_LINE, ORG, {
          purchase_order_id: PO,
          line_number: 1,
          description: "Radios",
          budget_line_id: null,
          element_id: "5000.02.02-XPMS-003",
          quantity: 4,
          unit_basis: null,
          unit_price_minor: 4500,
          acquisition_kind: "Rental",
          hire_period: HIRE,
        }),
      ],
      goods_returns: [
        tenantRow(RETURN, ORG, {
          purchase_order_id: PO,
          returned_at: "2027-06-05T12:00:00.000Z",
          returned_by: ME,
          return_reason: "Off Hire",
          note: null,
          created_by: ME,
          updated_by: ME,
        }),
      ],
      return_lines: [
        tenantRow(RETURN_LINE, ORG, {
          goods_return_id: RETURN,
          receipt_line_id: RECEIPT_LINE,
          asset_unit_id: UNIT,
          quantity_returned: 1,
          created_by: ME,
          updated_by: ME,
        }),
      ],
      po_line_hire_warnings: [
        {
          po_line_id: PO_LINE,
          org_id: ORG,
          project_id: PROJECT,
          purchase_order_id: PO,
          hire_period: HIRE,
          site_window: SITE,
          warning: "Delivery After Load In",
        },
      ],
      asset_unit_hire: [
        {
          asset_unit_id: UNIT,
          org_id: ORG,
          acquisition_kind: "Rental",
          hire_ends_at: "2027-06-05T12:00:00.000Z",
          off_hire_due: true,
        },
      ],
    },
    {
      receive_goods: (args) => {
        const lines = args["p_lines"] as Row[];
        if (lines.some((l) => Number(l["quantity"]) > 4)) {
          throw refusal("receipt_exceeds_order", "Receipts never exceed the quantity ordered.");
        }
        return {
          outcome: "applied",
          goods_receipt_id: args["p_event_id"],
          receipt_line_ids: [RECEIPT_LINE],
          asset_unit_ids: [UNIT],
          lot_movement_ids: [],
        };
      },
      return_goods: (args) => {
        if (args["p_reason"] === "Off Hire" && args["p_purchase_order_id"] !== PO) {
          throw refusal("return_off_hire_not_rental", "Off Hire returns only rental goods.");
        }
        return {
          outcome: "applied",
          goods_return_id: args["p_event_id"],
          return_line_ids: [RETURN_LINE],
        };
      },
      hire_window_warnings: (args) => {
        if (String(args["p_hire_to"]) <= String(args["p_hire_from"])) {
          throw refusal("hire_period_order", "A hire ends after it starts.");
        }
        return ["Delivery After Load In"];
      },
    },
    {
      po_lines: {
        budget_line_id: null,
        element_id: null,
        unit_basis: null,
        unit_price_minor: null,
        acquisition_kind: "Purchase",
        hire_period: null,
      },
    },
  );
  const app = contractApp({ handlers: [procurement, assets], db });
  return { db, app, http: requests(app) };
}

describe("Supply bridge contract: receiving and returning", () => {
  it("receives against an order through one RPC and replays the same Idempotency-Key", async () => {
    const { db, app } = world();
    const send = () =>
      app.request(`/purchase-orders/${PO}/receive`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "r7a-receive-1" },
        body: JSON.stringify({
          lines: [{ po_line_id: PO_LINE, quantity: 1, asset_tags: ["nwl-rad-101"] }],
          note: "One case.",
        }),
      });
    const first = (await expectContract(await success(send()), "purchaseOrders.receive")) as Row;
    expect(first).toMatchObject({ outcome: "applied", asset_unit_ids: [UNIT] });
    const again = (await expectContract(await success(send()), "purchaseOrders.receive")) as Row;
    expect(again).toEqual(first);
    const calls = db.calls.filter((c) => c.name === "receive_goods");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toMatchObject({
      p_event_id: first["goods_receipt_id"],
      p_purchase_order_id: PO,
      p_note: "One case.",
      p_lines: [{ po_line_id: PO_LINE, quantity: 1, asset_tags: ["nwl-rad-101"] }],
    });
  });

  it("answers a refused receipt with its rule", async () => {
    const { http } = world();
    const over = await http.post(`/purchase-orders/${PO}/receive`, {
      lines: [{ po_line_id: PO_LINE, quantity: 9 }],
    });
    expect(over.status).toBe(422);
    expect(await over.json()).toMatchObject({ rule: "receipt_exceeds_order" });
  });

  it("returns goods to the vendor and reads the return back", async () => {
    const { db, http } = world();
    const returned = await success(
      http.post(`/purchase-orders/${PO}/returns`, {
        reason: "Off Hire",
        lines: [{ receipt_line_id: RECEIPT_LINE, quantity: 1, asset_unit_ids: [UNIT] }],
      }),
    );
    const done = (await expectContract(returned, "purchaseOrders.returnGoods")) as Row;
    expect(done).toMatchObject({ outcome: "applied", return_line_ids: [RETURN_LINE] });
    expect(db.calls.find((c) => c.name === "return_goods")?.args).toMatchObject({
      p_reason: "Off Hire",
      p_lines: [{ receipt_line_id: RECEIPT_LINE, quantity: 1, asset_unit_ids: [UNIT] }],
    });
    const page = (await expectContract(
      await success(http.get("/goods-returns")),
      "goodsReturns.list",
    )) as { data: Row[] };
    expect(page.data[0]).toMatchObject({ id: RETURN, return_reason: "Off Hire" });
    await expectContract(await success(http.get(`/goods-returns/${RETURN}`)), "goodsReturns.get");
    const lines = (await expectContract(
      await success(http.get("/return-lines")),
      "returnLines.list",
    )) as { data: Row[] };
    expect(lines.data[0]).toMatchObject({ asset_unit_id: UNIT, quantity_returned: 1 });
    await expectContract(
      await success(http.get(`/return-lines/${RETURN_LINE}`)),
      "returnLines.get",
    );
  });
});

describe("Supply bridge contract: rental lines and window warnings", () => {
  it("splits the hire period into two instants and joins them on write", async () => {
    const { db, http } = world();
    const line = (await expectContract(
      await success(http.get(`/po-lines/${PO_LINE}`)),
      "poLines.get",
    )) as Row;
    expect(line).toMatchObject({
      acquisition_kind: "Rental",
      hire_starts_at: "2027-06-01T12:00:00.000Z",
      hire_ends_at: "2027-06-05T12:00:00.000Z",
    });
    const made = await success(
      http.post("/po-lines", {
        purchase_order_id: PO,
        description: "Truss hire",
        quantity: 2,
        acquisition_kind: "Rental",
        hire_starts_at: "2027-06-02T08:00:00Z",
        hire_ends_at: "2027-06-04T18:00:00Z",
      }),
    );
    await expectContract(made, "poLines.create");
    const insert = db.writes.find((w) => w.table === "po_lines" && w.op === "insert");
    expect(insert?.values).toMatchObject({
      acquisition_kind: "Rental",
      hire_period: "[2027-06-02T08:00:00Z,2027-06-04T18:00:00Z)",
    });
    expect(insert?.values).not.toHaveProperty("hire_starts_at");
    const changed = await success(
      http.patch(`/po-lines/${PO_LINE}`, { hire_ends_at: "2027-06-06T12:00:00Z" }),
    );
    await expectContract(changed, "poLines.update");
    const update = db.writes.find((w) => w.table === "po_lines" && w.op === "update");
    expect(update?.values).toMatchObject({
      hire_period: "[2027-06-01T12:00:00.000Z,2027-06-06T12:00:00Z)",
    });
    await success(http.patch(`/po-lines/${PO_LINE}`, { acquisition_kind: "Purchase" }));
    const cleared = db.writes.filter((w) => w.table === "po_lines" && w.op === "update").at(-1);
    expect(cleared?.values).toMatchObject({ acquisition_kind: "Purchase", hire_period: null });
  });

  it("lists the warnings of saved rental lines and of a hire being entered", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get("/po-line-hire-warnings")),
      "poLineHireWarnings.list",
    )) as { data: Row[] };
    expect(page.data[0]).toMatchObject({
      po_line_id: PO_LINE,
      warning: "Delivery After Load In",
      hire_starts_at: "2027-06-01T12:00:00.000Z",
      site_opens_at: "2027-05-31T08:00:00.000Z",
    });
    const window = `/po-lines/hire-window-warnings?project_id=${PROJECT}`;
    const warnings = (await expectContract(
      await success(http.get(`${window}&from=2027-06-01T12:00:00Z&to=2027-06-05T12:00:00Z`)),
      "poLines.hireWindowWarnings",
    )) as Row;
    expect(warnings["data"]).toEqual(["Delivery After Load In"]);
    const backwards = await http.get(`${window}&from=2027-06-05T12:00:00Z&to=2027-06-01T12:00:00Z`);
    expect(backwards.status).toBe(422);
    expect(await backwards.json()).toMatchObject({ rule: "hire_period_order" });
  });
});

describe("Supply bridge contract: hired-in units", () => {
  it("lists which units are hired in and when they go back, without vendor or cost", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get("/asset-unit-hire")),
      "assetUnitHire.list",
    )) as { data: Row[] };
    expect(page.data[0]).toEqual({
      asset_unit_id: UNIT,
      acquisition_kind: "Rental",
      hire_ends_at: "2027-06-05T12:00:00.000Z",
      off_hire_due: true,
    });
  });
});
