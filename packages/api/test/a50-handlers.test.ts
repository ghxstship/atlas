/**
 * Contract tests for A50's handlers (Section 18, gate 5, RRR-94): the operations that had no
 * handler after Wave 6, module by module. Requests run through `contractApp` against the in-memory
 * client and every success is checked against openapi/v1.json with `expectContract`. Row level
 * security, the column guards and the lifecycle RPCs are the database's; here RPCs are stand-ins
 * that refuse the way the database does, so refusals (422) and hidden rows (404) are covered too.
 */
import { describe, expect, it } from "vitest";
import { handlers as finance } from "../src/handlers/finance.ts";
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
