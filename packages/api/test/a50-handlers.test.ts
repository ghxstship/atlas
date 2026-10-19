/**
 * Contract tests for A50's handlers (Section 18, gate 5, RRR-94): the operations that had no
 * handler after Wave 6, module by module. Requests run through `contractApp` against the in-memory
 * client and every success is checked against openapi/v1.json with `expectContract`. Row level
 * security, the column guards and the lifecycle RPCs are the database's; here RPCs are stand-ins
 * that refuse the way the database does, so refusals (422) and hidden rows (404) are covered too.
 */
import { describe, expect, it } from "vitest";
import { handlers as canon } from "../src/handlers/canon.ts";
import { handlers as finance } from "../src/handlers/finance.ts";
import { handlers as hospitality } from "../src/handlers/hospitality.ts";
import { handlers as identity } from "../src/handlers/identity.ts";
import { handlers as logistics } from "../src/handlers/logistics.ts";
import { handlers as people } from "../src/handlers/people.ts";
import { handlers as settings } from "../src/handlers/settings.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";
import { sample } from "./support/samples.ts";

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

describe("Identity: organization relationships and account memberships", () => {
  const RELATIONSHIP = id(501);
  const OTHER_ORG = id(502);
  const PERSON = id(503);

  function world() {
    const db = memoryDb(
      {
        counterparties: [
          tenantRow(RELATIONSHIP, ORG, { organization_id: OTHER_ORG, counterparty_type: null }),
        ],
        account_memberships: [],
      },
      {
        add_account_member: (args, db) => {
          if (args["p_role"] === "Account Owner") throw refusal("account_owner_by_transfer");
          const row = tenantRow(id(504), String(args["p_account_id"]), {
            person_id: args["p_person_id"],
            valid_from: "2026-10-02T09:00:00.000Z",
            valid_to: null,
          });
          db.tables["account_memberships"]?.push(row);
          return row["id"];
        },
      },
      { counterparties: { counterparty_type: null } },
    );
    return { db, http: requests(contractApp({ handlers: [identity], db })) };
  }

  it("serves the org's relationships to other organizations", async () => {
    const { http } = world();
    await expectContract(
      await success(http.get("/organization-relationships")),
      "organizationRelationships.list",
    );
    await expectContract(
      await success(http.get(`/organization-relationships/${RELATIONSHIP}`)),
      "organizationRelationships.get",
    );
    expect((await http.get(`/organization-relationships/${MISSING}`)).status).toBe(404);
    const create = await success(
      http.post("/organization-relationships", { organization_id: id(505) }),
    );
    await expectContract(create, "organizationRelationships.create");
    const update = await success(
      http.patch(`/organization-relationships/${RELATIONSHIP}`, { counterparty_type: null }),
    );
    await expectContract(update, "organizationRelationships.update");
    await expectContract(
      await success(http.delete(`/organization-relationships/${RELATIONSHIP}`)),
      "organizationRelationships.delete",
    );
  });

  it("adds a person to the caller's external account with a first role", async () => {
    const { db, http } = world();
    const create = await success(
      http.post("/account-memberships", { person_id: PERSON, account_role: "Account Member" }),
    );
    const made = (await expectContract(create, "accountMemberships.create")) as {
      person_id: string;
    };
    expect(made.person_id).toBe(PERSON);
    expect(db.calls[0]?.args).toEqual({
      p_account_id: ORG,
      p_person_id: PERSON,
      p_role: "Account Member",
    });
    const owner = await http.post("/account-memberships", {
      person_id: PERSON,
      account_role: "Account Owner",
    });
    expect(owner.status).toBe(422);
  });
});

describe("Canon: library mirrors, rate cards, supersessions, ratifications and URNs", () => {
  const RESOURCES: [string, string, string, string, string][] = [
    [
      "/canon/std/document-library",
      "canonStdDocumentLibrary",
      "xpms.std_document_library",
      "StdDocument",
      "record_id",
    ],
    [
      "/canon/std/enumerations",
      "canonStdEnumerations",
      "xpms.std_enumeration",
      "StdEnumeration",
      "record_id",
    ],
    [
      "/canon/std/labor-rate-cards",
      "canonStdLaborRateCards",
      "xpms.rate_card_resolved",
      "StdLaborRateCard",
      "rate_card_id",
    ],
    [
      "/canon/std/radio-channels",
      "canonStdRadioChannels",
      "xpms.std_radio_channel",
      "StdRadioChannel",
      "record_id",
    ],
    ["/canon/std/roles", "canonStdRoles", "xpms.role", "StdRole", "role_code"],
    ["/canon/std/sops", "canonStdSops", "xpms.std_sop", "StdSop", "sop_id"],
    [
      "/canon/std/vendor-classes",
      "canonStdVendorClasses",
      "xpms.std_vendor_class",
      "StdVendorClass",
      "record_id",
    ],
    [
      "/canon/std/vendor-entitlements",
      "canonStdVendorEntitlements",
      "xpms.std_vendor_entitlement",
      "StdVendorEntitlement",
      "record_id",
    ],
    ["/canon/std/verbiage", "canonStdVerbiage", "xpms.std_verbiage", "StdVerbiage", "record_id"],
    [
      "/canon/ratifications",
      "canonRatifications",
      "xpms.ratification",
      "CanonRatification",
      "subject",
    ],
  ];

  function world() {
    const tables: Record<string, Row[]> = Object.fromEntries(
      RESOURCES.map(([, , table, component]) => [table, [sample(component)]]),
    );
    tables["xpms.supersession"] = [
      sample("CanonSupersession", { domain: "phase", code: "DIS", successor_code: "SCP" }),
      sample("CanonSupersession", { domain: "tier", code: "DIS", successor_code: "T02" }),
    ];
    const db = memoryDb(tables, {
      "xpms.urn_resolve": (args) =>
        args["urn"] === "urn:xpms:phase:DIS"
          ? [
              {
                kind: "phase",
                key: "DIS",
                resolved_key: "SCP",
                label: "Scoping",
                is_superseded: true,
              },
            ]
          : [],
    });
    return { db, http: requests(contractApp({ handlers: [canon], db })) };
  }

  it.each(RESOURCES)("serves %s", async (path, op, _table, component, key) => {
    const { http } = world();
    const listed = await success(http.get(path));
    const page = (await expectContract(listed, `${op}.list`)) as { data: Row[] };
    expect(page.data).toHaveLength(1);
    const read = await success(
      http.get(`${path}/${encodeURIComponent(String(page.data[0]?.[key]))}`),
    );
    await expectContract(read, `${op}.get`);
    const missing = await http.get(
      `${path}/${encodeURIComponent(String(sample(component)[key]))}-none`,
    );
    expect([404, 422]).toContain(missing.status);
  });

  it("lists and reads every library and governance resource", async () => {
    const { http } = world();
    const serve = async (path: string, key: string): Promise<[Response, Response]> => {
      const list = await success(http.get(path));
      const row = ((await list.clone().json()) as { data: Row[] }).data[0];
      const one = await success(http.get(`${path}/${encodeURIComponent(String(row?.[key]))}`));
      return [list, one];
    };
    const [l0, g0] = await serve("/canon/std/document-library", "record_id");
    await expectContract(l0, "canonStdDocumentLibrary.list");
    await expectContract(g0, "canonStdDocumentLibrary.get");
    const [l1, g1] = await serve("/canon/std/enumerations", "record_id");
    await expectContract(l1, "canonStdEnumerations.list");
    await expectContract(g1, "canonStdEnumerations.get");
    const [l2, g2] = await serve("/canon/std/labor-rate-cards", "rate_card_id");
    await expectContract(l2, "canonStdLaborRateCards.list");
    await expectContract(g2, "canonStdLaborRateCards.get");
    const [l3, g3] = await serve("/canon/std/radio-channels", "record_id");
    await expectContract(l3, "canonStdRadioChannels.list");
    await expectContract(g3, "canonStdRadioChannels.get");
    const [l4, g4] = await serve("/canon/std/roles", "role_code");
    await expectContract(l4, "canonStdRoles.list");
    await expectContract(g4, "canonStdRoles.get");
    const [l5, g5] = await serve("/canon/std/sops", "sop_id");
    await expectContract(l5, "canonStdSops.list");
    await expectContract(g5, "canonStdSops.get");
    const [l6, g6] = await serve("/canon/std/vendor-classes", "record_id");
    await expectContract(l6, "canonStdVendorClasses.list");
    await expectContract(g6, "canonStdVendorClasses.get");
    const [l7, g7] = await serve("/canon/std/vendor-entitlements", "record_id");
    await expectContract(l7, "canonStdVendorEntitlements.list");
    await expectContract(g7, "canonStdVendorEntitlements.get");
    const [l8, g8] = await serve("/canon/std/verbiage", "record_id");
    await expectContract(l8, "canonStdVerbiage.list");
    await expectContract(g8, "canonStdVerbiage.get");
    const [l9, g9] = await serve("/canon/ratifications", "subject");
    await expectContract(l9, "canonRatifications.list");
    await expectContract(g9, "canonRatifications.get");
  });

  it("lists supersessions by domain and code", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get("/canon/supersessions")),
      "canonSupersessions.list",
    )) as { data: Row[] };
    expect(page.data.map((r) => [r["domain"], r["code"]])).toEqual([
      ["phase", "DIS"],
      ["tier", "DIS"],
    ]);
    const phase = await success(http.get("/canon/supersessions?filter[domain][eq]=phase"));
    const filtered = (await expectContract(phase, "canonSupersessions.list")) as { data: Row[] };
    expect(filtered.data).toHaveLength(1);
  });

  it("resolves a URN through supersessions, and answers NO_ANSWER for an unknown one", async () => {
    const { http } = world();
    const resolved = await success(http.get("/canon/urns/resolve?urn=urn:xpms:phase:DIS"));
    const body = (await expectContract(resolved, "canonUrns.resolve")) as Row;
    expect(body).toMatchObject({ resolved_key: "SCP", is_superseded: true });
    const unknown = await http.get("/canon/urns/resolve?urn=urn:xpms:phase:NONE");
    expect(unknown.status).toBe(422);
    await expectContract(unknown, "canonUrns.resolve");
  });
});

describe("Settings: full org exports", () => {
  const EXPORT = id(601);
  const SHA = "9f2c4e1a7b3d5f6e8a0c2e4f6a8b0d2c4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b";

  function world() {
    const db = memoryDb(
      {
        org_exports: [
          tenantRow(EXPORT, ORG, {
            table_count: 412,
            row_count: 182340,
            file_count: 96,
            manifest_sha256: SHA,
          }),
        ],
      },
      {
        record_org_export: (args, db) => {
          if (args["p_table_count"] === 0) throw refusal("org_export_empty");
          const row = tenantRow(id(602), String(args["p_org_id"]), {
            table_count: args["p_table_count"],
            row_count: args["p_row_count"],
            file_count: args["p_file_count"],
            manifest_sha256: args["p_manifest_sha256"],
          });
          db.tables["org_exports"]?.push(row);
          return row["id"];
        },
      },
    );
    return { db, http: requests(contractApp({ handlers: [settings], db })) };
  }

  it("lists, reads and logs full exports", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/org-exports")), "orgExports.list");
    await expectContract(await success(http.get(`/org-exports/${EXPORT}`)), "orgExports.get");
    expect((await http.get(`/org-exports/${MISSING}`)).status).toBe(404);
    const create = await success(
      http.post("/org-exports", {
        table_count: 415,
        row_count: 190000,
        file_count: 97,
        manifest_sha256: SHA,
      }),
    );
    const made = (await expectContract(create, "orgExports.create")) as { table_count: number };
    expect(made.table_count).toBe(415);
    const refused = await http.post("/org-exports", {
      table_count: 0,
      row_count: 0,
      file_count: 0,
      manifest_sha256: SHA,
    });
    expect(refused.status).toBe(422);
  });
});
