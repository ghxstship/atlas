/**
 * Contract tests for A50's handlers (Section 18, gate 5, RRR-94): the operations that had no
 * handler after Wave 6, module by module. Requests run through `contractApp` against the in-memory
 * client and every success is checked against openapi/v1.json with `expectContract`. Row level
 * security, the column guards and the lifecycle RPCs are the database's; here RPCs are stand-ins
 * that refuse the way the database does, so refusals (422) and hidden rows (404) are covered too.
 */
import { describe, expect, it } from "vitest";
import { handlers as finance } from "../src/handlers/finance.ts";
import { handlers as hospitality } from "../src/handlers/hospitality.ts";
import { handlers as logistics } from "../src/handlers/logistics.ts";
import { handlers as people } from "../src/handlers/people.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(50000 + n).padStart(12, "0")}`;
const MISSING = id(9999);

describe("Finance: price books", () => {
  const BOOK = id(101);

  function world() {
    const db = memoryDb({
      price_books: [tenantRow(BOOK, ORG, { name: "Standard Client Rates", currency_code: "USD" })],
    });
    return { db, http: requests(contractApp({ handlers: [finance], db })) };
  }

  it("lists, reads, creates, updates and deletes price books", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get("/price-books")),
      "priceBooks.list",
    )) as { data: { name: string }[] };
    expect(page.data.map((b) => b.name)).toEqual(["Standard Client Rates"]);
    await expectContract(await success(http.get(`/price-books/${BOOK}`)), "priceBooks.get");
    expect((await http.get(`/price-books/${MISSING}`)).status).toBe(404);
    const create = await success(
      http.post("/price-books", { name: "Euro Rates", currency_code: "EUR" }),
    );
    const made = (await expectContract(create, "priceBooks.create")) as { currency_code: string };
    expect(made.currency_code).toBe("EUR");
    const update = await success(http.patch(`/price-books/${BOOK}`, { name: "Client Rates 2027" }));
    await expectContract(update, "priceBooks.update");
    await expectContract(await success(http.delete(`/price-books/${BOOK}`)), "priceBooks.delete");
    expect((await http.get(`/price-books/${BOOK}`)).status).toBe(404);
  });
});

describe("People: role assignments, requisitions and agreements", () => {
  const PROJECT = id(201);
  const ASSIGNMENT = id(202);
  const REQUISITION = id(203);
  const AGREEMENT = id(204);
  const PERSON = id(205);
  const ME = testContext().personId as string;

  function world() {
    const db = memoryDb(
      {
        role_assignments: [
          tenantRow(ASSIGNMENT, ORG, {
            project_id: PROJECT,
            role_code: "5000.50.01",
            scope_node_id: null,
            person_id: PERSON,
            requisition_id: null,
            staffing_basis: "Declared",
            starts_on: "2027-06-01",
            ends_on: "2027-06-03",
            assignment_state: "Proposed",
          }),
        ],
        requisitions: [
          tenantRow(REQUISITION, ORG, {
            project_id: PROJECT,
            role_code: "5000.50.01",
            requisition_state: "Proposed",
            scope_node_id: null,
            budget_line_id: null,
            role_type: null,
            worker_classification: "EMPLOYEE",
            pay_basis: "Hourly",
            arrangement: "Per Engagement",
            headcount: 4,
            units_per_head: 10,
            rate_minor: 4500,
            currency_code: "USD",
            starts_on: null,
            ends_on: null,
            justification: "Second stage added for the festival.",
            requested_by: PERSON,
          }),
        ],
        agreements: [
          tenantRow(AGREEMENT, ORG, {
            title: "Crew Agreement 2027",
            agreement_state: "Sent",
            signed_at: null,
            agreement_kind: "Contractor Agreement",
            body: "The crew member agrees to the call times in the schedule.",
            project_id: PROJECT,
            offer_id: null,
            person_id: ME,
            counterparty_id: null,
            token_expires_at: "2027-06-01T00:00:00.000Z",
            signed_name: null,
            signed_body_sha256: null,
          }),
        ],
      },
      {
        transition_requisition: (args, db) => {
          const row = db.tables["requisitions"]?.find((r) => r["id"] === args["p_requisition_id"]);
          if (row?.["requisition_state"] !== args["p_expected"])
            throw refusal("requisition_state_conflict");
          (row as Row)["requisition_state"] = args["p_next"];
          return id(7001);
        },
        approve_requisition: (args, db) => {
          const row = db.tables["requisitions"]?.find((r) => r["id"] === args["p_requisition_id"]);
          if (row?.["requested_by"] === ME) throw refusal("sod_approval_requester");
          (row as Row)["requisition_state"] = "Approved";
          return true;
        },
        sign_agreement: (args, db) => {
          const row = db.tables["agreements"]?.find((r) => r["id"] === args["p_agreement_id"]);
          if (row?.["agreement_state"] !== "Sent") return false;
          Object.assign(row, {
            agreement_state: "Signed",
            signed_at: "2026-10-02T09:00:00.000Z",
            signed_name: args["p_signed_name"],
            signed_body_sha256: args["p_body_sha256"],
          });
          return true;
        },
      },
      {
        role_assignments: { assignment_state: "Proposed", staffing_basis: "Declared" },
        requisitions: { requisition_state: "Proposed", headcount: 1, requested_by: ME },
        agreements: {
          agreement_state: "Proposed",
          signed_at: null,
          token_expires_at: null,
          signed_name: null,
          signed_body_sha256: null,
        },
      },
    );
    return { db, http: requests(contractApp({ handlers: [people], db })) };
  }

  it("serves role assignments", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/role-assignments")), "roleAssignments.list");
    await expectContract(
      await success(http.get(`/role-assignments/${ASSIGNMENT}`)),
      "roleAssignments.get",
    );
    expect((await http.get(`/role-assignments/${MISSING}`)).status).toBe(404);
    const create = await success(
      http.post("/role-assignments", {
        project_id: PROJECT,
        role_code: "5000.50.01",
        person_id: id(206),
        staffing_basis: "Ratio",
      }),
    );
    await expectContract(create, "roleAssignments.create");
    const update = await success(
      http.patch(`/role-assignments/${ASSIGNMENT}`, { ends_on: "2027-06-04" }),
    );
    await expectContract(update, "roleAssignments.update");
    await expectContract(
      await success(http.delete(`/role-assignments/${ASSIGNMENT}`)),
      "roleAssignments.delete",
    );
    expect((await http.get(`/role-assignments/${ASSIGNMENT}`)).status).toBe(404);
  });

  it("serves requisitions with their transitions and approval", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/requisitions")), "requisitions.list");
    await expectContract(
      await success(http.get(`/requisitions/${REQUISITION}`)),
      "requisitions.get",
    );
    const create = await success(
      http.post("/requisitions", {
        project_id: PROJECT,
        role_code: "5000.50.01",
        currency_code: "USD",
        justification: "Load-out crew.",
      }),
    );
    const made = (await expectContract(create, "requisitions.create")) as { id: string };
    const update = await success(http.patch(`/requisitions/${REQUISITION}`, { headcount: 6 }));
    await expectContract(update, "requisitions.update");
    const approve = await success(http.post(`/requisitions/${REQUISITION}/approve`));
    const approved = (await expectContract(approve, "requisitions.approve")) as {
      requisition_state: string;
    };
    expect(approved.requisition_state).toBe("Approved");
    const own = await http.post(`/requisitions/${made.id}/approve`);
    expect(own.status).toBe(422);
    const move = await success(
      http.post(`/requisitions/${REQUISITION}/transitions`, {
        expected_state: "Approved",
        to_state: "Filled",
        reason: "All four hired.",
      }),
    );
    await expectContract(move, "requisitions.transition");
    const stale = await http.post(`/requisitions/${REQUISITION}/transitions`, {
      expected_state: "Approved",
      to_state: "Canceled",
    });
    expect(stale.status).toBe(409);
    await expectContract(
      await success(http.delete(`/requisitions/${made.id}`)),
      "requisitions.delete",
    );
  });

  it("serves agreements and signs one as the person it names", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/agreements")), "agreements.list");
    await expectContract(await success(http.get(`/agreements/${AGREEMENT}`)), "agreements.get");
    const create = await success(
      http.post("/agreements", {
        title: "Non-Disclosure 2027",
        agreement_kind: "Non-Disclosure Agreement",
        body: "The parties keep the set list confidential.",
        person_id: id(206),
      }),
    );
    const made = (await expectContract(create, "agreements.create")) as { id: string };
    const update = await success(http.patch(`/agreements/${made.id}`, { title: "NDA 2027" }));
    await expectContract(update, "agreements.update");
    const sign = await success(
      http.post(`/agreements/${AGREEMENT}/sign`, {
        signed_name: "Alex Rivera",
        body_sha256: "9f2c4e1a7b3d5f6e8a0c2e4f6a8b0d2c4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b",
      }),
    );
    const signed = (await expectContract(sign, "agreements.sign")) as { agreement_state: string };
    expect(signed.agreement_state).toBe("Signed");
    const again = await http.post(`/agreements/${AGREEMENT}/sign`, {
      signed_name: "Alex Rivera",
      body_sha256: "9f2c4e1a7b3d5f6e8a0c2e4f6a8b0d2c4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b",
    });
    expect(again.status).toBe(422);
  });
});

describe("Hospitality: fulfillments, lines, BEOs and BEO lines", () => {
  const PROJECT = id(301);
  const FULFILLMENT = id(302);
  const LINE = id(303);
  const BEO = id(304);
  const BEO_LINE = id(305);

  function world() {
    const db = memoryDb(
      {
        fulfillments: [
          tenantRow(FULFILLMENT, ORG, {
            project_id: PROJECT,
            fulfillment_kind: "Catering",
            counterparty_id: null,
            title: "Crew Catering Opening Night",
            fulfillment_state: "Proposed",
            fulfillment_number: 3,
            starts_at: "2027-06-01T16:00:00.000Z",
            ends_at: null,
          }),
        ],
        fulfillment_lines: [
          tenantRow(LINE, ORG, {
            fulfillment_id: FULFILLMENT,
            description: "Hot meal",
            person_id: null,
            quantity: 80,
            unit_price_minor: null,
            currency_code: null,
          }),
        ],
        beos: [
          tenantRow(BEO, ORG, {
            project_id: PROJECT,
            fulfillment_id: FULFILLMENT,
            event_at: "2027-06-01T17:00:00.000Z",
            guest_count: null,
            beo_number: 4,
            approved_at: null,
            approved_by: null,
          }),
        ],
        beo_lines: [
          tenantRow(BEO_LINE, ORG, {
            beo_id: BEO,
            description: "Buffet dinner",
            quantity: 80,
            unit_price_minor: 2500,
            currency_code: "USD",
          }),
        ],
      },
      {
        transition_fulfillment: (args, db) => {
          const row = db.tables["fulfillments"]?.find((r) => r["id"] === args["p_fulfillment_id"]);
          if (args["p_next"] === "Complete") throw refusal("fulfillment_transition_not_allowed");
          (row as Row)["fulfillment_state"] = args["p_next"];
          return id(7002);
        },
      },
      {
        fulfillments: {
          fulfillment_state: "Proposed",
          fulfillment_number: 5,
          counterparty_id: null,
        },
        fulfillment_lines: { quantity: 1, person_id: null, currency_code: null },
        beos: { beo_number: 6, approved_at: null, approved_by: null, guest_count: null },
        beo_lines: { quantity: 1, currency_code: null, unit_price_minor: null },
      },
    );
    return { db, http: requests(contractApp({ handlers: [hospitality], db })) };
  }

  it("serves fulfillments and moves one with compare-and-set", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/fulfillments")), "fulfillments.list");
    await expectContract(
      await success(http.get(`/fulfillments/${FULFILLMENT}`)),
      "fulfillments.get",
    );
    expect((await http.get(`/fulfillments/${MISSING}`)).status).toBe(404);
    const create = await success(
      http.post("/fulfillments", {
        project_id: PROJECT,
        fulfillment_kind: "Lodging",
        title: "Crew Hotel",
      }),
    );
    await expectContract(create, "fulfillments.create");
    const update = await success(
      http.patch(`/fulfillments/${FULFILLMENT}`, { title: "Crew Catering, Opening Night" }),
    );
    await expectContract(update, "fulfillments.update");
    const move = await success(
      http.post(`/fulfillments/${FULFILLMENT}/transitions`, {
        expected_state: "Proposed",
        to_state: "Active",
      }),
    );
    const moved = (await expectContract(move, "fulfillments.transition")) as {
      fulfillment_state: string;
    };
    expect(moved.fulfillment_state).toBe("Active");
    const stale = await http.post(`/fulfillments/${FULFILLMENT}/transitions`, {
      expected_state: "Proposed",
      to_state: "Canceled",
    });
    expect(stale.status).toBe(409);
    const refused = await http.post(`/fulfillments/${FULFILLMENT}/transitions`, {
      expected_state: "Active",
      to_state: "Complete",
    });
    expect(refused.status).toBe(422);
    await expectContract(
      await success(http.delete(`/fulfillments/${FULFILLMENT}`)),
      "fulfillments.delete",
    );
  });

  it("serves fulfillment lines, unpriced lines without a currency", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/fulfillment-lines")), "fulfillmentLines.list");
    const one = (await expectContract(
      await success(http.get(`/fulfillment-lines/${LINE}`)),
      "fulfillmentLines.get",
    )) as { currency_code: string | null };
    expect(one.currency_code).toBeNull();
    const create = await success(
      http.post("/fulfillment-lines", { fulfillment_id: FULFILLMENT, description: "Room night" }),
    );
    const made = (await expectContract(create, "fulfillmentLines.create")) as { quantity: number };
    expect(made.quantity).toBe(1);
    const update = await success(
      http.patch(`/fulfillment-lines/${LINE}`, { unit_price_minor: 1800, currency_code: "USD" }),
    );
    await expectContract(update, "fulfillmentLines.update");
    await expectContract(
      await success(http.delete(`/fulfillment-lines/${LINE}`)),
      "fulfillmentLines.delete",
    );
  });

  it("serves BEOs and BEO lines", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/beos")), "beos.list");
    await expectContract(await success(http.get(`/beos/${BEO}`)), "beos.get");
    const create = await success(
      http.post("/beos", { project_id: PROJECT, event_at: "2027-06-02T17:00:00.000Z" }),
    );
    await expectContract(create, "beos.create");
    const update = await success(http.patch(`/beos/${BEO}`, { guest_count: 85 }));
    await expectContract(update, "beos.update");
    await expectContract(await success(http.delete(`/beos/${BEO}`)), "beos.delete");

    await expectContract(await success(http.get("/beo-lines")), "beoLines.list");
    await expectContract(await success(http.get(`/beo-lines/${BEO_LINE}`)), "beoLines.get");
    const line = await success(http.post("/beo-lines", { beo_id: BEO, description: "Coffee" }));
    await expectContract(line, "beoLines.create");
    const change = await success(http.patch(`/beo-lines/${BEO_LINE}`, { quantity: 85 }));
    await expectContract(change, "beoLines.update");
    await expectContract(await success(http.delete(`/beo-lines/${BEO_LINE}`)), "beoLines.delete");
  });
});

describe("Logistics: shipments, dock slots, the gate queue and the marshalling log", () => {
  const PROJECT = id(401);
  const SHIPMENT = id(402);
  const LINE = id(403);
  const SLOT = id(404);
  const ENTRY = id(405);
  const LOG = id(406);
  const ZONE = id(407);
  const NOW = "2026-10-02T09:00:00.000Z";

  function world() {
    const db = memoryDb(
      {
        shipments: [
          tenantRow(SHIPMENT, ORG, {
            project_id: PROJECT,
            direction: "Inbound",
            carrier_counterparty_id: null,
            freight_type_enum_id: null,
            tracking_identifier: "1Z999AA10123456784",
            ships_at: "2027-05-30T12:00:00.000Z",
            arrives_at: null,
            shipment_number: 7,
          }),
        ],
        shipment_lines: [
          tenantRow(LINE, ORG, {
            shipment_id: SHIPMENT,
            description: "Line array cases",
            element_id: null,
            quantity: 12,
          }),
        ],
        dock_slots: [
          tenantRow(SLOT, ORG, {
            project_id: PROJECT,
            zone_id: ZONE,
            shipment_id: SHIPMENT,
            starts_at: "2027-06-01T08:00:00.000Z",
            ends_at: "2027-06-01T09:00:00.000Z",
            checked_in_at: null,
            checked_in_by: null,
          }),
        ],
        gate_queue: [
          tenantRow(ENTRY, ORG, {
            project_id: PROJECT,
            shipment_id: SHIPMENT,
            vehicle_identifier: "FL TRK-2231",
            arrived_at: "2027-06-01T07:40:00.000Z",
            released_at: null,
            released_by: null,
          }),
        ],
        marshalling_log: [
          tenantRow(LOG, ORG, {
            project_id: PROJECT,
            shipment_id: SHIPMENT,
            zone_id: ZONE,
            entry: "Staged in lane 2.",
            logged_at: "2027-06-01T07:45:00.000Z",
          }),
        ],
      },
      {},
      {
        shipments: { shipment_number: 8, carrier_counterparty_id: null, arrives_at: null },
        shipment_lines: { quantity: 1, element_id: null },
        dock_slots: { checked_in_at: null, checked_in_by: null, shipment_id: null },
        gate_queue: { arrived_at: NOW, released_at: null, released_by: null, shipment_id: null },
        marshalling_log: { logged_at: NOW, shipment_id: null, zone_id: null },
      },
    );
    return { db, http: requests(contractApp({ handlers: [logistics], db })) };
  }

  it("serves shipments and their lines", async () => {
    const { db, http } = world();
    await expectContract(await success(http.get("/shipments")), "shipments.list");
    await expectContract(await success(http.get(`/shipments/${SHIPMENT}`)), "shipments.get");
    expect((await http.get(`/shipments/${MISSING}`)).status).toBe(404);
    const create = await success(
      http.post("/shipments", { project_id: PROJECT, direction: "Outbound" }),
    );
    const made = (await expectContract(create, "shipments.create")) as { id: string };
    const update = await success(
      http.patch(`/shipments/${SHIPMENT}`, { arrives_at: "2027-06-01T07:30:00.000Z" }),
    );
    await expectContract(update, "shipments.update");

    await expectContract(await success(http.get("/shipment-lines")), "shipmentLines.list");
    await expectContract(await success(http.get(`/shipment-lines/${LINE}`)), "shipmentLines.get");
    const line = await success(
      http.post("/shipment-lines", { shipment_id: SHIPMENT, description: "Rigging motors" }),
    );
    await expectContract(line, "shipmentLines.create");
    const change = await success(http.patch(`/shipment-lines/${LINE}`, { quantity: 14 }));
    await expectContract(change, "shipmentLines.update");
    await expectContract(
      await success(http.delete(`/shipment-lines/${LINE}`)),
      "shipmentLines.delete",
    );

    db.fail("shipments", refusal("shipment_in_use"));
    const refusedDelete = await http.delete(`/shipments/${made.id}`);
    expect(refusedDelete.status).toBe(422);
    await expectContract(await success(http.delete(`/shipments/${made.id}`)), "shipments.delete");
    expect((await http.get(`/shipments/${made.id}`)).status).toBe(404);
  });

  it("books dock slots and checks a shipment in once", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/dock-slots")), "dockSlots.list");
    await expectContract(await success(http.get(`/dock-slots/${SLOT}`)), "dockSlots.get");
    const create = await success(
      http.post("/dock-slots", {
        project_id: PROJECT,
        zone_id: ZONE,
        starts_at: "2027-06-01T10:00:00.000Z",
        ends_at: "2027-06-01T11:00:00.000Z",
      }),
    );
    const made = (await expectContract(create, "dockSlots.create")) as { id: string };
    const update = await success(
      http.patch(`/dock-slots/${SLOT}`, { ends_at: "2027-06-01T09:30:00.000Z" }),
    );
    await expectContract(update, "dockSlots.update");

    const checkedIn = await success(http.post(`/dock-slots/${SLOT}/check-in`));
    const slot = (await expectContract(checkedIn, "dockSlots.checkIn")) as {
      checked_in_at: string | null;
    };
    expect(slot.checked_in_at).not.toBeNull();
    expect((await http.post(`/dock-slots/${SLOT}/check-in`)).status).toBe(422);
    await expectContract(await success(http.delete(`/dock-slots/${made.id}`)), "dockSlots.delete");
  });

  it("queues vehicles at the gate and releases them once", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/gate-queue")), "gateQueueEntries.list");
    await expectContract(await success(http.get(`/gate-queue/${ENTRY}`)), "gateQueueEntries.get");
    const create = await success(
      http.post("/gate-queue", { project_id: PROJECT, vehicle_identifier: "GA VAN-0412" }),
    );
    await expectContract(create, "gateQueueEntries.create");
    const update = await success(
      http.patch(`/gate-queue/${ENTRY}`, { vehicle_identifier: "FL TRK-2232" }),
    );
    await expectContract(update, "gateQueueEntries.update");
    const release = await success(http.post(`/gate-queue/${ENTRY}/release`));
    await expectContract(release, "gateQueueEntries.release");
    expect((await http.post(`/gate-queue/${ENTRY}/release`)).status).toBe(422);
  });

  it("appends to the marshalling log", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/marshalling-log")), "marshallingLogEntries.list");
    await expectContract(
      await success(http.get(`/marshalling-log/${LOG}`)),
      "marshallingLogEntries.get",
    );
    const create = await success(
      http.post("/marshalling-log", { project_id: PROJECT, entry: "Released to dock 1." }),
    );
    await expectContract(create, "marshallingLogEntries.create");
  });
});
