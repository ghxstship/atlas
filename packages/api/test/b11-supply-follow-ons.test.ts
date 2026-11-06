/**
 * Contract tests for B11's supply chain follow-ons (RRR-235, migrations 3001 to 3006): needs and their computed status,
 * request lines, sub-hire drafts, maintenance plans and what is due, delivery windows and booking. Requests run through
 * `contractApp` against the in-memory client, and every success is checked against openapi/v1.json with `expectContract`.
 */
import { describe, expect, it } from "vitest";
import { handlers as assets } from "../src/handlers/assets.ts";
import { handlers as logistics } from "../src/handlers/logistics.ts";
import { handlers as procurement } from "../src/handlers/procurement.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { MemoryDb, Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const ME = testContext().personId as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(30000 + n).padStart(12, "0")}`;
const PROJECT = id(1);
const NEED = id(2);
const RFQ = id(3);
const RFQ_LINE = id(4);
const PLAN = id(5);
const UNIT = id(6);
const ZONE = id(7);
const WINDOW = id(8);
const SLOT = id(9);
const CLASS = id(10);
const ALLOCATION = id(11);

function world() {
  const db: MemoryDb = memoryDb(
    {
      procurement_needs: [
        tenantRow(NEED, ORG, {
          created_by: ME,
          updated_by: ME,
          project_id: PROJECT,
          need_number: 1,
          description: "Truss Sections",
          quantity: 15,
          unit_basis: null,
          asset_class_id: CLASS,
          element_id: null,
          needed_during: '["2027-06-01 12:00:00+00","2027-06-05 12:00:00+00")',
          note: null,
        }),
      ],
      procurement_need_status: [
        {
          need_id: NEED,
          org_id: ORG,
          project_id: PROJECT,
          description: "Truss Sections",
          quantity: 15,
          requested_quantity: 15,
          drafted_quantity: 0,
          ordered_quantity: 5,
          received_quantity: 0,
          need_status: "Short",
        },
      ],
      rfq_lines: [
        tenantRow(RFQ_LINE, ORG, {
          created_by: ME,
          updated_by: ME,
          rfq_id: RFQ,
          line_number: 1,
          description: "Truss Sections",
          element_id: null,
          quantity: 5,
          unit_basis: null,
          acquisition_kind: "Rental",
          hire_period: '["2027-06-01 12:00:00+00","2027-06-05 12:00:00+00")',
          procurement_need_id: NEED,
        }),
      ],
      asset_maintenance_plans: [
        tenantRow(PLAN, ORG, {
          created_by: ME,
          updated_by: ME,
          asset_unit_id: UNIT,
          asset_class_id: null,
          title: "Inspect welds",
          instructions: null,
          first_due_on: "2027-06-01",
          every_count: 3,
          every_unit: "Month",
        }),
      ],
      asset_maintenance_due: [
        {
          plan_id: PLAN,
          org_id: ORG,
          asset_unit_id: UNIT,
          title: "Inspect welds",
          last_performed_on: null,
          due_on: "2027-06-01",
          due_status: "Pending",
        },
      ],
      delivery_windows: [
        tenantRow(WINDOW, ORG, {
          created_by: ME,
          updated_by: ME,
          project_id: PROJECT,
          zone_id: ZONE,
          starts_at: "2027-06-01T12:00:00.000Z",
          ends_at: "2027-06-01T14:00:00.000Z",
          vehicle_limit: 5,
          is_open: true,
        }),
      ],
      dock_slots: [
        tenantRow(SLOT, ORG, {
          created_by: ME,
          updated_by: ME,
          project_id: PROJECT,
          zone_id: ZONE,
          shipment_id: null,
          engagement_id: null,
          starts_at: "2027-06-01T12:00:00.000Z",
          ends_at: "2027-06-01T14:00:00.000Z",
          checked_in_at: null,
          checked_in_by: null,
          delivery_window_id: WINDOW,
          reference_code: "K7M2QX",
          vehicle_identifier: null,
        }),
      ],
    },
    {
      consolidate_allocations: () => [NEED],
      create_sub_hire_rfq: (args) => {
        if ((args["p_asset_class_ids"] as string[]).length === 0) {
          throw refusal("sub_hire_not_short", "Own stock now covers this item.");
        }
        return args["p_event_id"];
      },
      asset_shortages: () => [
        {
          project_id: PROJECT,
          project_key: "NWL",
          asset_class_id: CLASS,
          class_name: "Truss Sections",
          element_id: "3000.05.01-GHXST-014",
          unit_basis: null,
          short_quantity: 5,
          window_from: "2027-06-01T12:00:00.000Z",
          window_to: "2027-06-05T12:00:00.000Z",
          open_need_id: NEED,
          open_rfq_id: null,
        },
      ],
      create_delivery_windows: () => [WINDOW],
      book_delivery_window: () => SLOT,
      cancel_delivery_booking: () => null,
    },
    {
      procurement_needs: {
        created_by: ME,
        updated_by: ME,
        need_number: 2,
        unit_basis: null,
        asset_class_id: null,
        element_id: null,
        needed_during: null,
        note: null,
      },
      rfq_lines: {
        created_by: ME,
        updated_by: ME,
        line_number: 2,
        element_id: null,
        unit_basis: null,
        acquisition_kind: "Purchase",
        hire_period: null,
        procurement_need_id: null,
      },
      asset_maintenance_plans: {
        created_by: ME,
        updated_by: ME,
        asset_unit_id: null,
        asset_class_id: null,
        instructions: null,
        every_count: null,
        every_unit: null,
      },
      delivery_windows: { created_by: ME, updated_by: ME },
    },
  );
  const app = contractApp({ handlers: [procurement, assets, logistics], db });
  return { db, app, http: requests(app) };
}

describe("B11 contract: procurement needs", () => {
  it("lists, reads, creates, updates and deletes a need, with its window as two instants", async () => {
    const { http } = world();
    const list = (await expectContract(
      await success(http.get("/procurement-needs")),
      "procurementNeeds.list",
    )) as {
      data: Row[];
    };
    expect(list.data[0]).toMatchObject({ id: NEED, needed_from: "2027-06-01T12:00:00.000Z" });
    await expectContract(
      await success(http.get(`/procurement-needs/${NEED}`)),
      "procurementNeeds.get",
    );
    const sent1 = await success(
      http.post("/procurement-needs", { project_id: PROJECT, description: "Mics", quantity: 12 }),
    );
    await expectContract(sent1, "procurementNeeds.create");
    const sent2 = await success(http.patch(`/procurement-needs/${NEED}`, { quantity: 20 }));
    await expectContract(sent2, "procurementNeeds.update");
    await expectContract(
      await success(http.delete(`/procurement-needs/${NEED}`)),
      "procurementNeeds.delete",
    );
  });

  it("consolidates through one RPC and reads the status it computes", async () => {
    const { db, http } = world();
    const sent3 = await success(
      http.post("/procurement-needs/consolidate", { allocation_ids: [ALLOCATION] }),
    );
    const result = (await expectContract(sent3, "procurementNeeds.consolidate")) as {
      data: string[];
    };
    expect(result.data).toEqual([NEED]);
    expect(db.calls.find((c) => c.name === "consolidate_allocations")?.args).toMatchObject({
      p_allocation_ids: [ALLOCATION],
    });
    const status = (await expectContract(
      await success(http.get("/procurement-need-status")),
      "procurementNeedStatus.list",
    )) as { data: Row[] };
    expect(status.data[0]).toMatchObject({ need_status: "Short", ordered_quantity: 5 });
  });
});

describe("B11 contract: request lines and sub-hire", () => {
  it("lists, reads, creates, updates and deletes a request line, with its hire as two instants", async () => {
    const { http } = world();
    const list = (await expectContract(await success(http.get("/rfq-lines")), "rfqLines.list")) as {
      data: Row[];
    };
    expect(list.data[0]).toMatchObject({
      acquisition_kind: "Rental",
      hire_starts_at: "2027-06-01T12:00:00.000Z",
    });
    await expectContract(await success(http.get(`/rfq-lines/${RFQ_LINE}`)), "rfqLines.get");
    const sent4 = await success(
      http.post("/rfq-lines", {
        rfq_id: RFQ,
        description: "Clamps",
        quantity: 8,
        acquisition_kind: "Purchase",
      }),
    );
    await expectContract(sent4, "rfqLines.create");
    const sent5 = await success(http.patch(`/rfq-lines/${RFQ_LINE}`, { quantity: 6 }));
    await expectContract(sent5, "rfqLines.update");
    await expectContract(await success(http.delete(`/rfq-lines/${RFQ_LINE}`)), "rfqLines.delete");
  });

  it("reads shortages and drafts a sub-hire", async () => {
    const { http } = world();
    const short = (await expectContract(
      await success(http.get("/asset-classes/shortages")),
      "assetClasses.shortages",
    )) as { data: Row[] };
    expect(short.data[0]).toMatchObject({ short_quantity: 5 });
    expect(short.data[0]).not.toHaveProperty("unit_price_minor");
    const sent6 = await success(
      http.post("/rfqs/sub-hire", {
        project_id: PROJECT,
        asset_class_ids: [CLASS],
        title: "Sub-hire truss",
      }),
    );
    await expectContract(sent6, "rfqs.createSubHire");
  });

  it("answers a covered class with its rule", async () => {
    const { http } = world();
    const refused = await http.post("/rfqs/sub-hire", {
      project_id: PROJECT,
      asset_class_ids: [],
      title: "None",
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });
});

describe("B11 contract: maintenance plans", () => {
  it("lists, reads, creates, updates and deletes a plan, and reads what is due", async () => {
    const { http } = world();
    await expectContract(
      await success(http.get("/asset-maintenance-plans")),
      "assetMaintenancePlans.list",
    );
    await expectContract(
      await success(http.get(`/asset-maintenance-plans/${PLAN}`)),
      "assetMaintenancePlans.get",
    );
    const sent7 = await success(
      http.post("/asset-maintenance-plans", {
        asset_unit_id: UNIT,
        title: "Replace cable",
        first_due_on: "2027-07-01",
      }),
    );
    await expectContract(sent7, "assetMaintenancePlans.create");
    const sent8 = await success(
      http.patch(`/asset-maintenance-plans/${PLAN}`, { title: "Inspect all welds" }),
    );
    await expectContract(sent8, "assetMaintenancePlans.update");
    await expectContract(
      await success(http.delete(`/asset-maintenance-plans/${PLAN}`)),
      "assetMaintenancePlans.delete",
    );
    const due = (await expectContract(
      await success(http.get("/asset-maintenance-due")),
      "assetMaintenanceDue.list",
    )) as { data: Row[] };
    expect(due.data[0]).toMatchObject({ due_status: "Pending", due_on: "2027-06-01" });
  });
});

describe("B11 contract: delivery windows", () => {
  it("lists, reads, creates, updates and deletes a window", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/delivery-windows")), "deliveryWindows.list");
    await expectContract(
      await success(http.get(`/delivery-windows/${WINDOW}`)),
      "deliveryWindows.get",
    );
    const sent9 = await success(
      http.post("/delivery-windows", {
        project_id: PROJECT,
        zone_id: ZONE,
        starts_at: "2027-06-02T12:00:00.000Z",
        ends_at: "2027-06-02T14:00:00.000Z",
        vehicle_limit: 3,
        is_open: true,
      }),
    );
    await expectContract(sent9, "deliveryWindows.create");
    const sent10 = await success(http.patch(`/delivery-windows/${WINDOW}`, { vehicle_limit: 6 }));
    await expectContract(sent10, "deliveryWindows.update");
    await expectContract(
      await success(http.delete(`/delivery-windows/${WINDOW}`)),
      "deliveryWindows.delete",
    );
  });

  it("generates a schedule, books a place with its code, and cancels it", async () => {
    const { http } = world();
    const sent11 = await success(
      http.post("/delivery-windows/generate", {
        project_id: PROJECT,
        zone_id: ZONE,
        first_day: "2027-06-01",
        last_day: "2027-06-01",
        from_time: "08:00",
        to_time: "10:00",
        slot_minutes: 60,
        vehicle_limit: 5,
      }),
    );
    const made = (await expectContract(sent11, "deliveryWindows.generate")) as { data: string[] };
    expect(made.data).toEqual([WINDOW]);
    const sent12 = await success(
      http.post(`/delivery-windows/${WINDOW}/book`, { vehicle_identifier: "FL ABC 123" }),
    );
    const booked = (await expectContract(sent12, "deliveryWindows.book")) as Row;
    expect(booked).toEqual({ dock_slot_id: SLOT, reference_code: "K7M2QX" });
    const sent13 = await success(http.post(`/dock-slots/${SLOT}/cancel-booking`, {}));
    await expectContract(sent13, "dockSlots.cancelBooking");
  });
});
