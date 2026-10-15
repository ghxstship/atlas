/**
 * A04P contract tests for the Settings parity handlers (src/handlers/settings/parity.ts). Requests
 * run through `contractApp` against the in-memory client; every response is checked against
 * openapi/v1.json with `expectContract`.
 */
import { describe, expect, it } from "vitest";
import { handlers } from "../src/handlers/settings.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";
import { sample } from "./support/samples.ts";

const ORG = testContext().org?.id as string;
const ME = testContext().personId as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const TIMES = {
  created_at: "2026-10-01T12:00:00.000Z",
  created_by: null,
  updated_at: "2026-10-01T12:00:00.000Z",
  updated_by: null,
};

function seed(component: string, rowId: string, extra: Row = {}): Row {
  return { ...sample(component, { id: rowId, ...TIMES, org_id: ORG, ...extra }), deleted_at: null };
}

/** A row of a keyless view or registry table: the sample as is. */
function view(component: string, extra: Row = {}): Row {
  return sample(component, extra);
}

function world() {
  const db = memoryDb(
    {
      subscriptions: [seed("Subscription", id(1101), { subscription_state: "active" })],
      plans: [
        view("Plan", { code: "team", sort_order: 2 }),
        view("Plan", { code: "access", sort_order: 1 }),
      ],
      workspaces: [seed("Workspace", id(1102))],
      workspace_members: [seed("WorkspaceMember", id(1103))],
      teams: [seed("Team", id(1104))],
      team_members: [seed("TeamMember", id(1105))],
      org_brands: [seed("OrgBranding", id(1106))],
      roles: [seed("Role", id(1107), { code: "lighting_lead", band: 3 })],
      capabilities: [view("Capability")],
      role_capabilities: [seed("RoleCapability", id(1108))],
      user_capability_grants: [seed("UserCapabilityGrant", id(1109), { valid_to: null })],
      record_grants: [seed("RecordGrant", id(1110))],
      delegations: [seed("Delegation", id(1111))],
      spend_authorities: [seed("SpendAuthority", id(1112))],
      separation_of_duties_rules: [view("SeparationOfDutiesRule")],
      column_classifications: [
        view("ColumnClassification", { table_name: "people", column_name: "full_name" }),
        view("ColumnClassification", { table_name: "people", column_name: "email" }),
        view("ColumnClassification", { table_name: "tax_forms", column_name: "tin_last4" }),
      ],
      api_keys: [seed("ApiKey", id(1113), { secret_hash: "\\x00", revoked_at: null })],
      service_accounts: [seed("ServiceAccount", id(1114))],
      webhook_endpoints: [
        { ...seed("WebhookEndpoint", id(1115), { disabled_at: null }), events: undefined },
      ],
      webhook_endpoint_events: [
        {
          id: id(1125),
          webhook_endpoint_id: id(1115),
          event_type: "record.created",
          deleted_at: null,
        },
      ],
      webhook_deliveries: [seed("WebhookDelivery", id(1116))],
      domain_event_catalog: [view("WebhookEventType")],
      audit_events: [{ ...sample("AuditEvent", { id: id(1117), org_id: ORG, ...TIMES }) }],
      consent_records: [seed("ConsentRecord", id(1118), { person_id: ME })],
      dsar_requests: [seed("DsarRequest", id(1119))],
      retention_policies: [view("RetentionPolicy")],
    },
    {
      create_api_key: (args, self) => {
        self.tables["api_keys"]?.push(
          seed("ApiKey", id(1130 + (self.tables["api_keys"]?.length ?? 0)), {
            name: args["p_name"],
            scopes: args["p_scopes"],
            revoked_at: null,
          }),
        );
        return [{ api_key_id: id(1130), secret: "xos_live_7Hq2wQ1nC8vL0pR4tY6u" }];
      },
      revoke_api_key: (args, self) => {
        const key = self.tables["api_keys"]?.find((k) => k["id"] === args["p_api_key_id"]);
        if (key) key["revoked_at"] = "2026-10-02T09:00:00.000Z";
        return null;
      },
      create_service_account: (args, self) => {
        self.tables["service_accounts"]?.push(
          seed("ServiceAccount", id(1140), { name: args["p_name"], owner_person_id: ME }),
        );
        return id(1140);
      },
      retire_service_account: () => null,
      create_webhook_endpoint: () => [
        { webhook_endpoint_id: id(1150), signing_secret: "whsec_5Jk2pQ8xL1nV7cR3" },
      ],
      replay_webhook_delivery: () => id(1116),
    },
    {
      workspace_members: { org_id: ORG },
      team_members: { org_id: ORG },
      role_capabilities: { org_id: ORG },
      user_capability_grants: {
        org_id: ORG,
        granted_by: ME,
        valid_from: "2026-10-02T09:00:00.000Z",
        valid_to: null,
        scope_kind: "organization",
        scope_id: null,
      },
      record_grants: { org_id: ORG, granted_by: ME, grantee_org_id: null },
      delegations: { org_id: ORG },
      org_brands: { radius_scale: "Default", suppress_powered_by: false },
      consent_records: {
        captured_at: "2026-10-02T09:00:00.000Z",
        captured_ip: null,
        withdrawn_at: null,
      },
      dsar_requests: { received_at: "2026-10-02T09:00:00.000Z", dsar_state: "Received" },
    },
  );
  const app = contractApp({ handlers: [handlers], db });
  return { db, http: requests(app) };
}

describe("subscriptions, plans and capabilities", () => {
  it("reads subscriptions and the registries", async () => {
    const { http } = world();
    const subscriptions = await http.get("/subscriptions");
    await expectContract(await success(subscriptions), "subscriptions.list");
    const subscription = await http.get(`/subscriptions/${id(1101)}`);
    await expectContract(await success(subscription), "subscriptions.get");
    const plans = await http.get("/plans");
    const page = (await expectContract(await success(plans), "plans.list")) as { data: Row[] };
    expect(page.data.map((p) => p["code"])).toEqual(["access", "team"]);
    const capabilities = await http.get("/capabilities");
    await expectContract(await success(capabilities), "capabilities.list");
    const rules = await http.get("/separation-of-duties-rules");
    await expectContract(await success(rules), "separationOfDutiesRules.list");
    const events = await http.get("/webhook-events");
    await expectContract(await success(events), "webhookEventTypes.list");
    const retention = await http.get("/retention-policies");
    await expectContract(await success(retention), "retentionPolicies.list");
  });

  it("pages column classifications by table and column", async () => {
    const { http } = world();
    const first = await http.get("/column-classifications?limit=2");
    const page = (await expectContract(await success(first), "columnClassifications.list")) as {
      data: Row[];
      next_cursor: string;
    };
    expect(page.data.map((r) => r["column_name"])).toEqual(["email", "full_name"]);
    const next = await http.get(`/column-classifications?limit=2&cursor=${page.next_cursor}`);
    const rest = (await expectContract(await success(next), "columnClassifications.list")) as {
      data: Row[];
    };
    expect(rest.data.map((r) => r["table_name"])).toEqual(["tax_forms"]);
  });
});

describe("workspaces, teams and branding", () => {
  it("serves workspaces and their members", async () => {
    const { http } = world();
    const listed = await http.get("/workspaces");
    await expectContract(await success(listed), "workspaces.list");
    const read = await http.get(`/workspaces/${id(1102)}`);
    await expectContract(await success(read), "workspaces.get");
    const made = await http.post("/workspaces", { name: "Touring", slug: "touring" });
    await expectContract(await success(made), "workspaces.create");
    const edited = await http.patch(`/workspaces/${id(1102)}`, { name: "Festivals" });
    await expectContract(await success(edited), "workspaces.update");
    const removed = await http.delete(`/workspaces/${id(1102)}`);
    await expectContract(await success(removed), "workspaces.delete");

    const members = await http.get("/workspace-members");
    await expectContract(await success(members), "workspaceMembers.list");
    const member = await http.get(`/workspace-members/${id(1103)}`);
    await expectContract(await success(member), "workspaceMembers.get");
    const added = await http.post("/workspace-members", {
      workspace_id: id(1102),
      membership_id: id(1190),
    });
    await expectContract(await success(added), "workspaceMembers.create");
    const dropped = await http.delete(`/workspace-members/${id(1103)}`);
    await expectContract(await success(dropped), "workspaceMembers.delete");
  });

  it("serves teams and their members", async () => {
    const { http } = world();
    const listed = await http.get("/teams");
    await expectContract(await success(listed), "teams.list");
    const read = await http.get(`/teams/${id(1104)}`);
    await expectContract(await success(read), "teams.get");
    const made = await http.post("/teams", { name: "Lighting" });
    await expectContract(await success(made), "teams.create");
    const edited = await http.patch(`/teams/${id(1104)}`, { name: "Audio" });
    await expectContract(await success(edited), "teams.update");
    const removed = await http.delete(`/teams/${id(1104)}`);
    await expectContract(await success(removed), "teams.delete");

    const members = await http.get("/team-members");
    await expectContract(await success(members), "teamMembers.list");
    const member = await http.get(`/team-members/${id(1105)}`);
    await expectContract(await success(member), "teamMembers.get");
    const added = await http.post("/team-members", { team_id: id(1104), membership_id: id(1190) });
    await expectContract(await success(added), "teamMembers.create");
    const dropped = await http.delete(`/team-members/${id(1105)}`);
    await expectContract(await success(dropped), "teamMembers.delete");
  });

  it("serves branding", async () => {
    const { http } = world();
    const listed = await http.get("/org-branding");
    await expectContract(await success(listed), "orgBrandings.list");
    const read = await http.get(`/org-branding/${id(1106)}`);
    await expectContract(await success(read), "orgBrandings.get");
    const made = await http.post("/org-branding", { display_name: "Demo Live" });
    await expectContract(await success(made), "orgBrandings.create");
    const edited = await http.patch(`/org-branding/${id(1106)}`, { suppress_powered_by: true });
    await expectContract(await success(edited), "orgBrandings.update");
    const removed = await http.delete(`/org-branding/${id(1106)}`);
    await expectContract(await success(removed), "orgBrandings.delete");
  });
});

describe("roles, grants and authority", () => {
  it("serves roles and their capabilities", async () => {
    const { http } = world();
    const listed = await http.get("/roles");
    await expectContract(await success(listed), "roles.list");
    const read = await http.get(`/roles/${id(1107)}`);
    await expectContract(await success(read), "roles.get");
    const made = await http.post("/roles", { code: "rigging_lead", band: 3, name: "Rigging Lead" });
    await expectContract(await success(made), "roles.create");
    const edited = await http.patch(`/roles/${id(1107)}`, {
      description: "Leads the lighting crew.",
    });
    await expectContract(await success(edited), "roles.update");
    const band = await http.patch(`/roles/${id(1107)}`, { band: 2 });
    expect(band.status).toBe(422);
    const removed = await http.delete(`/roles/${id(1107)}`);
    await expectContract(await success(removed), "roles.delete");

    const caps = await http.get("/role-capabilities");
    await expectContract(await success(caps), "roleCapabilities.list");
    const cap = await http.get(`/role-capabilities/${id(1108)}`);
    await expectContract(await success(cap), "roleCapabilities.get");
    const granted = await http.post("/role-capabilities", {
      role_id: id(1107),
      capability_code: "finance.po.approve",
      reach: "organization",
    });
    await expectContract(await success(granted), "roleCapabilities.create");
    const revoked = await http.delete(`/role-capabilities/${id(1108)}`);
    await expectContract(await success(revoked), "roleCapabilities.delete");
  });

  it("serves capability grants, record grants and delegations", async () => {
    const { http } = world();
    const grants = await http.get("/user-capability-grants");
    await expectContract(await success(grants), "userCapabilityGrants.list");
    const grant = await http.get(`/user-capability-grants/${id(1109)}`);
    await expectContract(await success(grant), "userCapabilityGrants.get");
    const madeGrant = await http.post("/user-capability-grants", {
      capability_code: "finance.po.approve",
      membership_id: id(1190),
      reason: "Covering the producer's leave.",
    });
    await expectContract(await success(madeGrant), "userCapabilityGrants.create");
    const endedGrant = await http.patch(`/user-capability-grants/${id(1109)}`, {
      valid_to: "2027-01-01T00:00:00Z",
    });
    await expectContract(await success(endedGrant), "userCapabilityGrants.update");
    const removedGrant = await http.delete(`/user-capability-grants/${id(1109)}`);
    await expectContract(await success(removedGrant), "userCapabilityGrants.delete");

    const records = await http.get("/record-grants");
    await expectContract(await success(records), "recordGrants.list");
    const record = await http.get(`/record-grants/${id(1110)}`);
    await expectContract(await success(record), "recordGrants.get");
    const madeRecord = await http.post(
      "/record-grants",
      sample("RecordGrantCreate", { valid_to: "2027-01-01T00:00:00Z" }),
    );
    await expectContract(await success(madeRecord), "recordGrants.create");
    const endedRecord = await http.patch(`/record-grants/${id(1110)}`, {
      valid_to: "2027-02-01T00:00:00Z",
    });
    await expectContract(await success(endedRecord), "recordGrants.update");
    const reasonChange = await http.patch(`/record-grants/${id(1110)}`, { reason: "Other." });
    expect(reasonChange.status).toBe(422);
    const removedRecord = await http.delete(`/record-grants/${id(1110)}`);
    await expectContract(await success(removedRecord), "recordGrants.delete");

    const delegations = await http.get("/delegations");
    await expectContract(await success(delegations), "delegations.list");
    const delegation = await http.get(`/delegations/${id(1111)}`);
    await expectContract(await success(delegation), "delegations.get");
    const madeDelegation = await http.post("/delegations", sample("DelegationCreate"));
    await expectContract(await success(madeDelegation), "delegations.create");
    const endedDelegation = await http.patch(`/delegations/${id(1111)}`, {
      valid_to: "2027-03-01T00:00:00Z",
    });
    await expectContract(await success(endedDelegation), "delegations.update");
    const removedDelegation = await http.delete(`/delegations/${id(1111)}`);
    await expectContract(await success(removedDelegation), "delegations.delete");
  });

  it("serves spend authority", async () => {
    const { http } = world();
    const listed = await http.get("/spend-authority");
    await expectContract(await success(listed), "spendAuthorityLimits.list");
    const read = await http.get(`/spend-authority/${id(1112)}`);
    await expectContract(await success(read), "spendAuthorityLimits.get");
    const made = await http.post("/spend-authority", sample("SpendAuthorityCreate"));
    await expectContract(await success(made), "spendAuthorityLimits.create");
    const edited = await http.patch(`/spend-authority/${id(1112)}`, { limit_minor: 500000 });
    await expectContract(await success(edited), "spendAuthorityLimits.update");
    const removed = await http.delete(`/spend-authority/${id(1112)}`);
    await expectContract(await success(removed), "spendAuthorityLimits.delete");
  });
});

describe("API keys and service accounts", () => {
  it("creates a key with its secret once, edits, revokes and rotates it", async () => {
    const { db, http } = world();
    const listed = await http.get("/api-keys");
    const page = (await expectContract(await success(listed), "apiKeys.list")) as { data: Row[] };
    expect(page.data[0]).not.toHaveProperty("secret_hash");
    const read = await http.get(`/api-keys/${id(1113)}`);
    await expectContract(await success(read), "apiKeys.get");
    const made = await http.post("/api-keys", {
      name: "ERP sync",
      scopes: ["finance"],
      expires_at: "2027-10-01T00:00:00Z",
    });
    const secret = (await expectContract(await success(made), "apiKeys.create")) as Row;
    expect(secret["secret"]).toMatch(/^xos_live_/);
    const edited = await http.patch(`/api-keys/${id(1113)}`, { name: "ERP sync v2" });
    await expectContract(await success(edited), "apiKeys.update");
    const rotated = await http.post(`/api-keys/${id(1113)}/rotate`);
    await expectContract(await success(rotated), "apiKeys.rotate");
    const revoked = await http.post(`/api-keys/${id(1113)}/revoke`);
    const key = (await expectContract(await success(revoked), "apiKeys.revoke")) as Row;
    expect(key["revoked_at"]).not.toBeNull();
    expect(db.calls.map((c) => c.name)).toEqual([
      "create_api_key",
      "create_api_key",
      "revoke_api_key",
      "revoke_api_key",
    ]);
  });

  it("creates, edits and retires a service account", async () => {
    const { db, http } = world();
    const listed = await http.get("/service-accounts");
    await expectContract(await success(listed), "serviceAccounts.list");
    const read = await http.get(`/service-accounts/${id(1114)}`);
    await expectContract(await success(read), "serviceAccounts.get");
    const made = await http.post("/service-accounts", { name: "ERP", role_id: id(1107) });
    await expectContract(await success(made), "serviceAccounts.create");
    const edited = await http.patch(`/service-accounts/${id(1114)}`, { name: "ERP Sync" });
    await expectContract(await success(edited), "serviceAccounts.update");
    const retired = await http.delete(`/service-accounts/${id(1114)}`);
    await expectContract(await success(retired), "serviceAccounts.delete");
    db.fail("rpc:create_service_account", refusal("service_account_role_owner"));
    const refused = await http.post("/service-accounts", { name: "Root", role_id: id(1107) });
    expect(refused.status).toBe(422);
  });
});

describe("webhooks", () => {
  it("creates an endpoint with its secret once and edits its events", async () => {
    const { http } = world();
    const listed = await http.get("/webhook-endpoints");
    const page = (await expectContract(await success(listed), "webhookEndpoints.list")) as {
      data: Row[];
    };
    expect(page.data[0]?.["events"]).toEqual(["record.created"]);
    const read = await http.get(`/webhook-endpoints/${id(1115)}`);
    await expectContract(await success(read), "webhookEndpoints.get");
    const made = await http.post("/webhook-endpoints", {
      url: "https://erp.example.com/hooks/xos",
      events: ["record.created"],
    });
    await expectContract(await success(made), "webhookEndpoints.create");
    const edited = await http.patch(`/webhook-endpoints/${id(1115)}`, {
      events: ["record.updated"],
      description: "ERP",
    });
    const endpoint = (await expectContract(
      await success(edited),
      "webhookEndpoints.update",
    )) as Row;
    expect(endpoint["events"]).toEqual(["record.updated"]);
    const removed = await http.delete(`/webhook-endpoints/${id(1115)}`);
    await expectContract(await success(removed), "webhookEndpoints.delete");
  });

  it("reads deliveries and requests a replay", async () => {
    const { http } = world();
    const listed = await http.get("/webhook-deliveries");
    await expectContract(await success(listed), "webhookDeliveries.list");
    const read = await http.get(`/webhook-deliveries/${id(1116)}`);
    await expectContract(await success(read), "webhookDeliveries.get");
    const replayed = await http.post(`/webhook-deliveries/${id(1116)}/replay`);
    expect(replayed.status).toBe(202);
    await expectContract(await success(replayed), "webhookDeliveries.replay");
  });
});

describe("audit, consent, DSAR", () => {
  it("serves the audit ledger, consent records and data subject requests", async () => {
    const { http } = world();
    const audits = await http.get("/audit-events");
    await expectContract(await success(audits), "auditEvents.list");
    const audit = await http.get(`/audit-events/${id(1117)}`);
    await expectContract(await success(audit), "auditEvents.get");

    const consents = await http.get("/consent-records");
    await expectContract(await success(consents), "consentRecords.list");
    const consent = await http.get(`/consent-records/${id(1118)}`);
    await expectContract(await success(consent), "consentRecords.get");
    const captured = await http.post("/consent-records", {
      person_id: ME,
      purpose_code: "marketing_email",
      notice_version: "2026-09",
      source: "Web",
    });
    await expectContract(await success(captured), "consentRecords.create");

    const requestsList = await http.get("/dsar-requests");
    await expectContract(await success(requestsList), "dsarRequests.list");
    const dsar = await http.get(`/dsar-requests/${id(1119)}`);
    await expectContract(await success(dsar), "dsarRequests.get");
    const filed = await http.post("/dsar-requests", {
      request_type: "Access",
      subject_email: "crew@example.com",
    });
    await expectContract(await success(filed), "dsarRequests.create");
  });
});
