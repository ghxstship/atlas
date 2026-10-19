/**
 * Contract tests for A52's handlers (RRR-97, ADR 0032 amendment): the settings features A50 retired
 * and A52 built in migrations 1200 to 1206. Requests run through `contractApp` against the in-memory
 * client and every success is checked against openapi/v1.json with `expectContract`. Row level
 * security, the guards and the RPCs are the database's (pgTAP 1200 to 1206); here RPCs and queued
 * failures refuse the way the database does, so refusals (422) and hidden rows (404) are covered.
 */
import { describe, expect, it } from "vitest";
import { handlers as identity } from "../src/handlers/identity.ts";
import { handlers as settings } from "../src/handlers/settings.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { globalRow, memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const ME = testContext().personId as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(52000 + n).padStart(12, "0")}`;
const MISSING = id(9999);

describe("Settings: legal entities", () => {
  const ENTITY = id(101);

  function world() {
    // The masked view and the table are one set of rows here, as the view reads the table.
    const rows: Row[] = [
      tenantRow(ENTITY, ORG, {
        legal_name: "Northwind Live LLC",
        country_code: "US",
        tax_identifier: null,
        tax_identifier_last4: "6789",
        is_masked: true,
        fiscal_year_start_month: 1,
        base_currency: "USD",
        is_primary: true,
      }),
    ];
    const db = memoryDb(
      { org_legal_entities: rows, org_legal_entities_masked: rows },
      {
        set_org_legal_entity_tax_identifier: (args) => {
          const value = args["p_tax_identifier"] as string | null;
          if (value !== null && value.replace(/[^0-9A-Za-z]/g, "").length < 4) {
            throw refusal("tax_identifier_format");
          }
          const row = rows.find((r) => r["id"] === args["p_legal_entity_id"]) as Row;
          Object.assign(row, {
            tax_identifier: value,
            tax_identifier_last4: value === null ? null : value.slice(-4),
            is_masked: false,
          });
          return null;
        },
      },
      {
        org_legal_entities: {
          tax_identifier: null,
          tax_identifier_last4: null,
          is_masked: false,
          is_primary: false,
        },
      },
    );
    return { db, http: requests(contractApp({ handlers: [settings], db })) };
  }

  it("lists with the tax identifier masked, creates through the RPC, updates and deletes", async () => {
    const { db, http } = world();
    const page = (await expectContract(
      await success(http.get("/org-legal-entities")),
      "orgLegalEntities.list",
    )) as { data: { tax_identifier: unknown; tax_identifier_last4: string }[] };
    expect(page.data[0]?.tax_identifier).toEqual({
      masked: true,
      reason: "Requires data.restricted.read.tax.",
    });
    expect(page.data[0]?.tax_identifier_last4).toBe("6789");
    await expectContract(
      await success(http.get(`/org-legal-entities/${ENTITY}`)),
      "orgLegalEntities.get",
    );
    expect((await http.get(`/org-legal-entities/${MISSING}`)).status).toBe(404);

    const response1 = await success(
      http.post("/org-legal-entities", {
        legal_name: "Northwind Live Ltd",
        country_code: "GB",
        tax_identifier: "GB123456789",
        fiscal_year_start_month: 4,
        base_currency: "GBP",
      }),
    );
    const made = (await expectContract(response1, "orgLegalEntities.create")) as {
      id: string;
      tax_identifier_last4: string;
    };
    expect(made.tax_identifier_last4).toBe("6789");
    expect(db.calls.map((c) => c.name)).toContain("set_org_legal_entity_tax_identifier");

    const response2 = await success(
      http.patch(`/org-legal-entities/${made.id}`, { is_primary: true }),
    );
    await expectContract(response2, "orgLegalEntities.update");
    const bad = await http.patch(`/org-legal-entities/${made.id}`, { tax_identifier: "12" });
    expect(bad.status).toBe(422);
    await expectContract(
      await success(http.delete(`/org-legal-entities/${made.id}`)),
      "orgLegalEntities.delete",
    );
  });
});

describe("Settings: IP allow-list", () => {
  const ENTRY = id(201);

  function world() {
    const db = memoryDb({
      org_ip_allowlist: [tenantRow(ENTRY, ORG, { cidr: "203.0.113.0/24", label: "Office" })],
    });
    return { db, http: requests(contractApp({ handlers: [settings], db })) };
  }

  it("lists, reads, creates, relabels and removes networks", async () => {
    const { db, http } = world();
    await expectContract(
      await success(http.get("/org-ip-allowlist")),
      "orgIpAllowlistEntries.list",
    );
    await expectContract(
      await success(http.get(`/org-ip-allowlist/${ENTRY}`)),
      "orgIpAllowlistEntries.get",
    );
    const response3 = await success(
      http.post("/org-ip-allowlist", { cidr: "198.51.100.0/24", label: "VPN" }),
    );
    await expectContract(response3, "orgIpAllowlistEntries.create");
    const response4 = await success(
      http.patch(`/org-ip-allowlist/${ENTRY}`, { label: "Head office" }),
    );
    await expectContract(response4, "orgIpAllowlistEntries.update");
    db.fail("org_ip_allowlist", refusal("ip_allowlist_last_entry"));
    expect((await http.delete(`/org-ip-allowlist/${ENTRY}`)).status).toBe(422);
    await expectContract(
      await success(http.delete(`/org-ip-allowlist/${ENTRY}`)),
      "orgIpAllowlistEntries.delete",
    );
  });
});

describe("Settings: access reviews", () => {
  const CAMPAIGN = id(301);
  const ITEM = id(302);

  function world() {
    const db = memoryDb(
      {
        access_review_campaigns: [
          tenantRow(CAMPAIGN, ORG, {
            name: "Q4 Access Review",
            due_on: "2026-11-02",
            auto_remove_unreviewed: false,
            campaign_state: "Active",
            opened_at: "2026-10-19T12:00:00.000Z",
            closed_at: null,
          }),
        ],
        access_review_items: [
          tenantRow(ITEM, ORG, {
            access_review_campaign_id: CAMPAIGN,
            membership_role_id: id(303),
            decision: null,
            decided_by: null,
            decided_at: null,
            flagged_at: null,
          }),
        ],
      },
      {},
      {
        access_review_campaigns: {
          auto_remove_unreviewed: false,
          campaign_state: "Active",
          opened_at: "2026-10-19T12:00:00.000Z",
          closed_at: null,
        },
      },
    );
    return { db, http: requests(contractApp({ handlers: [settings], db })) };
  }

  it("runs a campaign and records decisions", async () => {
    const { db, http } = world();
    await expectContract(
      await success(http.get("/access-review-campaigns")),
      "accessReviewCampaigns.list",
    );
    await expectContract(
      await success(http.get(`/access-review-campaigns/${CAMPAIGN}`)),
      "accessReviewCampaigns.get",
    );
    const response5 = await success(
      http.post("/access-review-campaigns", { name: "Q1 Access Review", due_on: "2027-01-15" }),
    );
    await expectContract(response5, "accessReviewCampaigns.create");
    const response6 = await success(
      http.patch(`/access-review-campaigns/${CAMPAIGN}`, { due_on: "2026-11-09" }),
    );
    await expectContract(response6, "accessReviewCampaigns.update");
    await expectContract(await success(http.get("/access-review-items")), "accessReviewItems.list");
    await expectContract(
      await success(http.get(`/access-review-items/${ITEM}`)),
      "accessReviewItems.get",
    );
    db.fail("access_review_items", refusal("sod_self_review"));
    expect(
      (await http.patch(`/access-review-items/${ITEM}`, { decision: "Confirmed" })).status,
    ).toBe(422);
    const response7 = await success(
      http.patch(`/access-review-items/${ITEM}`, { decision: "Removed" }),
    );
    const decided = (await expectContract(response7, "accessReviewItems.update")) as {
      decision: string;
    };
    expect(decided.decision).toBe("Removed");
    await expectContract(
      await success(http.delete(`/access-review-campaigns/${CAMPAIGN}`)),
      "accessReviewCampaigns.delete",
    );
  });
});

describe("Settings: break-glass sessions", () => {
  const SESSION = id(401);

  function world() {
    const session = (extra: Row = {}) =>
      tenantRow(SESSION, ORG, {
        person_id: ME,
        reason: "Payroll export failed during show day and must run now.",
        started_at: "2026-10-19T12:00:00.000Z",
        expires_at: "2026-10-19T13:00:00.000Z",
        ended_at: null,
        ...extra,
      });
    const db = memoryDb(
      { break_glass_sessions: [] },
      {
        start_break_glass: (args, mem) => {
          if (String(args["p_reason"]).length < 20) throw refusal("break_glass_reason");
          const row = session();
          (mem.tables["break_glass_sessions"] as Row[]).push(row);
          return row;
        },
        end_break_glass: (args, mem) => {
          const row = mem.tables["break_glass_sessions"]?.find(
            (r) => r["id"] === args["p_session_id"],
          );
          if (row?.["ended_at"] !== null) throw refusal("break_glass_closed");
          row["ended_at"] = "2026-10-19T12:20:00.000Z";
          return row;
        },
      },
    );
    return { db, http: requests(contractApp({ handlers: [settings], db })) };
  }

  it("opens a session through the RPC, lists it and ends it early", async () => {
    const { db, http } = world();
    db.fail("rpc:start_break_glass", refusal("step_up_required"));
    expect(
      (
        await http.post("/break-glass-sessions", {
          reason: "Payroll export failed during show day and must run now.",
        })
      ).status,
    ).toBe(422);
    const response8 = await success(
      http.post("/break-glass-sessions", {
        reason: "Payroll export failed during show day and must run now.",
      }),
    );
    const opened = (await expectContract(response8, "breakGlassSessions.create")) as {
      id: string;
      expires_at: string;
    };
    expect(opened.expires_at).toBe("2026-10-19T13:00:00.000Z");
    await expectContract(
      await success(http.get("/break-glass-sessions")),
      "breakGlassSessions.list",
    );
    await expectContract(
      await success(http.get(`/break-glass-sessions/${SESSION}`)),
      "breakGlassSessions.get",
    );
    const ended = (await expectContract(
      await success(http.post(`/break-glass-sessions/${SESSION}/end`)),
      "breakGlassSessions.end",
    )) as { ended_at: string | null };
    expect(ended.ended_at).not.toBeNull();
    expect((await http.post(`/break-glass-sessions/${SESSION}/end`)).status).toBe(422);
    expect((await http.post(`/break-glass-sessions/${MISSING}/end`)).status).toBe(404);
  });
});

describe("Settings: project shares", () => {
  const SHARE = id(501);
  const PROJECT = id(502);
  const PARTNER = id(503);
  const NODE = id(504);

  function world() {
    const db = memoryDb(
      {
        project_shares: [
          tenantRow(SHARE, ORG, {
            project_id: PROJECT,
            partner_organization_id: PARTNER,
            project_role: "Coordinator",
            valid_from: "2026-10-19T12:00:00.000Z",
            valid_to: null,
          }),
        ],
        project_share_scope_nodes: [
          tenantRow(id(505), ORG, { project_share_id: SHARE, scope_node_id: NODE }),
        ],
      },
      {},
      {
        project_shares: {
          org_id: ORG,
          project_role: "Coordinator",
          valid_from: "2026-10-19T12:00:00.000Z",
          valid_to: null,
        },
      },
    );
    return { db, http: requests(contractApp({ handlers: [settings], db })) };
  }

  it("shares a project with scope nodes, changes and revokes the share", async () => {
    const { db, http } = world();
    const page = (await expectContract(
      await success(http.get("/project-shares")),
      "projectShares.list",
    )) as { data: { scope_node_ids: string[] }[] };
    expect(page.data[0]?.scope_node_ids).toEqual([NODE]);
    await expectContract(await success(http.get(`/project-shares/${SHARE}`)), "projectShares.get");
    const response9 = await success(
      http.post("/project-shares", {
        project_id: PROJECT,
        partner_organization_id: id(506),
        project_role: "Field Supervisor",
        scope_node_ids: [NODE],
      }),
    );
    const made = (await expectContract(response9, "projectShares.create")) as {
      scope_node_ids: string[];
      project_role: string;
    };
    expect(made.scope_node_ids).toEqual([NODE]);
    expect(made.project_role).toBe("Field Supervisor");
    const response10 = await success(
      http.patch(`/project-shares/${SHARE}`, { scope_node_ids: [] }),
    );
    const changed = (await expectContract(response10, "projectShares.update")) as {
      scope_node_ids: string[];
    };
    expect(changed.scope_node_ids).toEqual([]);
    db.fail("project_shares", refusal("project_share_own_org"));
    expect(
      (await http.post("/project-shares", { project_id: PROJECT, partner_organization_id: ORG }))
        .status,
    ).toBe(422);
    await expectContract(
      await success(http.delete(`/project-shares/${SHARE}`)),
      "projectShares.delete",
    );
    expect((await http.get(`/project-shares/${SHARE}`)).status).toBe(404);
  });
});

describe("Identity: project assignment roles and blocks", () => {
  const ROLE = id(601);
  const BLOCK = id(602);

  function world() {
    const db = memoryDb(
      {
        project_member_roles: [
          tenantRow(ROLE, ORG, { project_member_id: id(603), project_role: "Field" }),
        ],
        blocks: [
          globalRow(BLOCK, {
            person_id: ME,
            blocked_urn: `urn:xpms:person:${id(604)}`,
          }),
        ],
      },
      {},
      { project_member_roles: { org_id: ORG } },
    );
    return { db, http: requests(contractApp({ handlers: [identity], db })) };
  }

  it("adds and removes project roles on an assignment", async () => {
    const { db, http } = world();
    await expectContract(
      await success(http.get("/project-assignment-roles")),
      "projectAssignmentRoles.list",
    );
    await expectContract(
      await success(http.get(`/project-assignment-roles/${ROLE}`)),
      "projectAssignmentRoles.get",
    );
    const response11 = await success(
      http.post("/project-assignment-roles", {
        project_member_id: id(603),
        project_role: "Field Supervisor",
      }),
    );
    await expectContract(response11, "projectAssignmentRoles.create");
    db.fail("project_member_roles", refusal("sod_self_grant"));
    expect(
      (
        await http.post("/project-assignment-roles", {
          project_member_id: id(607),
          project_role: "Producer",
        })
      ).status,
    ).toBe(422);
    await expectContract(
      await success(http.delete(`/project-assignment-roles/${ROLE}`)),
      "projectAssignmentRoles.delete",
    );
  });

  it("blocks and unblocks a profile", async () => {
    const { db, http } = world();
    await expectContract(await success(http.get("/blocks")), "blocks.list");
    await expectContract(await success(http.get(`/blocks/${BLOCK}`)), "blocks.get");
    const response12 = await success(
      http.post("/blocks", { blocked_urn: `urn:xpms:organization:${id(605)}` }),
    );
    await expectContract(response12, "blocks.create");
    db.fail("blocks", refusal("block_self"));
    expect((await http.post("/blocks", { blocked_urn: `urn:xpms:person:${ME}` })).status).toBe(422);
    await expectContract(await success(http.delete(`/blocks/${BLOCK}`)), "blocks.delete");
    expect((await http.get(`/blocks/${BLOCK}`)).status).toBe(404);
  });
});
