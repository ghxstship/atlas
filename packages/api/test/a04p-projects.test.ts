/**
 * A04P contract tests for the Projects operations ADR 0023 opened: projects.create, archive and
 * unarchive, and the gate evidence resource. Requests run through `contractApp` against the
 * in-memory client; every response is checked against openapi/v1.json with `expectContract`.
 */
import { describe, expect, it } from "vitest";
import { handlers } from "../src/handlers/projects.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const PROJECT = "0192f1e2-7c3a-7b4d-9e8f-000000001001";
const NEW_PROJECT = "0192f1e2-7c3a-7b4d-9e8f-000000001099";
const EVIDENCE = "0192f1e2-7c3a-7b4d-9e8f-000000004001";

function projectRow(id: string, over: Row = {}): Row {
  return tenantRow(id, ORG, {
    project_key: "NWS",
    name: "Northwind Summer Series",
    description: null,
    workspace_id: null,
    jurisdiction_id: "US-FL-MIAMI-DADE",
    region_code: "NA-SE-MIA",
    tier_code: "05",
    current_phase_code: "ENG",
    project_state: "Active",
    currency: "USD",
    starts_on: "2027-03-12",
    ends_on: "2027-03-15",
    time_zone: "America/New_York",
    venue_id: null,
    client_counterparty_id: null,
    production_state: "Active",
    archived_at: null,
    ...over,
  });
}

function world() {
  const db = memoryDb(
    {
      projects: [projectRow(PROJECT)],
      gate_evidence: [
        tenantRow(EVIDENCE, ORG, {
          project_id: PROJECT,
          criterion_id: "G2.CONTRACTS",
          record_id: null,
          attested_by: null,
          attested_at: "2026-10-01T12:00:00.000Z",
          assertion_rank: 4,
          evidence_uri: "urn:xpms:documents:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
          note: "Signed copy.",
        }),
      ],
    },
    {
      create_project: (args, self) => {
        self.tables["projects"]?.push(
          projectRow(NEW_PROJECT, {
            project_key: args["p_project_key"],
            name: args["p_name"],
            time_zone: args["p_time_zone"],
            current_phase_code: "SCP",
            project_state: "Proposed",
            production_state: "Proposed",
          }),
        );
        return NEW_PROJECT;
      },
    },
    { gate_evidence: { attested_at: "2026-10-02T08:00:00.000Z", attested_by: null } },
  );
  const app = contractApp({ handlers: [handlers], db });
  return { db, app, http: requests(app) };
}

describe("projects lifecycle operations", () => {
  it("creates a project through app.create_project", async () => {
    const { db, http } = world();
    const response = await http.post("/projects", {
      name: "Northwind Winter Gala",
      project_key: "NWG",
      time_zone: "America/Chicago",
      workspace_id: "0192f1e2-7c3a-7b4d-9e8f-000000005001",
    });
    const body = (await expectContract(await success(response), "projects.create")) as Row;
    expect(body["project_key"]).toBe("NWG");
    expect(body["workspace_id"]).toBe("0192f1e2-7c3a-7b4d-9e8f-000000005001");
    expect(db.calls[0]?.args["p_org_id"]).toBe(ORG);
  });

  it("answers a refused create with 422 and the rule", async () => {
    const { db, http } = world();
    db.fail("rpc:create_project", refusal("plan_limit_active_projects"));
    const response = await http.post("/projects", {
      name: "Over The Limit",
      project_key: "OTL",
      time_zone: "America/Chicago",
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as Row)["rule"]).toBe("plan_limit_active_projects");
  });

  it("archives and unarchives a project", async () => {
    const { http } = world();
    const archived = await http.post(`/projects/${PROJECT}/archive`);
    const body = (await expectContract(await success(archived), "projects.archive")) as Row;
    expect(body["archived_at"]).not.toBeNull();
    const restored = await http.post(`/projects/${PROJECT}/unarchive`);
    const after = (await expectContract(await success(restored), "projects.unarchive")) as Row;
    expect(after["archived_at"]).toBeNull();
    const missing = await http.post(`/projects/${NEW_PROJECT}/archive`);
    expect(missing.status).toBe(404);
  });
});

describe("gate evidence", () => {
  it("lists, reads, attests and withdraws evidence", async () => {
    const { db, http } = world();
    const listed = await http.get("/gate-evidence?filter[project_id][eq]=" + PROJECT);
    const page = (await expectContract(await success(listed), "gateEvidence.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);

    const read = await http.get(`/gate-evidence/${EVIDENCE}`);
    const row = (await expectContract(await success(read), "gateEvidence.get")) as Row;
    expect(row["criterion_id"]).toBe("G2.CONTRACTS");

    const attested = await http.post("/gate-evidence", {
      project_id: PROJECT,
      criterion_id: "G2.ACCOUNTABLE_PARTY",
      assertion_rank: 3,
      evidence_uri: "https://docs.example.test/accountable.pdf",
    });
    const made = (await expectContract(await success(attested), "gateEvidence.create")) as Row;
    expect(made["org_id"]).toBe(ORG);

    const withdrawn = await http.delete(`/gate-evidence/${EVIDENCE}`);
    await expectContract(await success(withdrawn), "gateEvidence.delete");
    const after = await http.get(`/gate-evidence/${EVIDENCE}`);
    expect(after.status).toBe(404);
    expect(db.writes.some((w) => w.op === "update")).toBe(true);
  });
});
