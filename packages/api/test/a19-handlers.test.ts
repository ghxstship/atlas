/**
 * A19 handlers (Settings: integrations, OAuth apps and grants, SCIM group mappings) end to end through
 * the runtime against the in-memory client. Every response is checked against openapi/v1.json with
 * expectContract (Section 18, gate 5).
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

const connection = (n: number, extra: Row = {}): Row => ({
  id: id(n),
  org_id: ORG,
  ...TIMES,
  provider_code: "xero",
  display_name: "Northwind Xero",
  external_account_id: "tenant-nwl",
  connection_state: "Pending",
  credential_kind: null,
  credential_expires_at: null,
  last_synced_at: null,
  last_error_code: null,
  last_error_message: null,
  deleted_at: null,
  ...extra,
});

function world() {
  const db = memoryDb(
    {
      integration_connections: [
        connection(9001),
        connection(9002, {
          provider_code: "slack",
          display_name: "Slack",
          connection_state: "Connected",
        }),
      ],
      oauth_apps: [
        { ...sample("OauthApp", { id: id(9101), ...TIMES, org_id: ORG }), deleted_at: null },
      ],
      oauth_grants: [
        {
          ...sample("OauthGrant", {
            id: id(9201),
            ...TIMES,
            org_id: ORG,
            person_id: ME,
            oauth_app_id: id(9101),
          }),
          deleted_at: null,
        },
      ],
      scim_group_mappings: [
        {
          ...sample("ScimGroupMapping", {
            id: id(9301),
            ...TIMES,
            org_id: ORG,
            identity_provider_id: id(9401),
          }),
          deleted_at: null,
        },
      ],
    },
    {
      transition_integration_connection: (args, self) => {
        const row = self.tables["integration_connections"]?.find(
          (r) => r["id"] === args["p_connection_id"],
        );
        if (row) row["connection_state"] = args["p_next"];
        return id(9500);
      },
      store_integration_credential: (args, self) => {
        const row = self.tables["integration_connections"]?.find(
          (r) => r["id"] === args["p_connection_id"],
        );
        if (row) {
          row["credential_kind"] = args["p_kind"];
          row["credential_expires_at"] = args["p_expires_at"];
        }
        return null;
      },
      enqueue_integration_sync: () => id(9600),
    },
    {
      integration_connections: {
        connection_state: "Pending",
        credential_kind: null,
        credential_expires_at: null,
        last_synced_at: null,
        last_error_code: null,
        last_error_message: null,
      },
      oauth_apps: { client_id: "xos_client_0123456789abcdef01234567" },
    },
  );
  const app = contractApp({ handlers: [handlers], db });
  return { db, http: requests(app) };
}

describe("integrations", () => {
  it("lists, reads, creates and edits connections", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get("/integrations")),
      "integrations.list",
    )) as { data: Row[] };
    expect(page.data).toHaveLength(2);
    expect(page.data[0]).not.toHaveProperty("secret");
    await expectContract(await success(http.get(`/integrations/${id(9001)}`)), "integrations.get");
    const made = await http.post("/integrations", {
      provider_code: "google_calendar",
      display_name: "Production Calendar",
    });
    const body = (await expectContract(await success(made), "integrations.create")) as Row;
    expect(body["connection_state"]).toBe("Pending");
    const edited = await http.patch(`/integrations/${id(9001)}`, { display_name: "Books" });
    expect(
      ((await expectContract(await success(edited), "integrations.update")) as Row)["display_name"],
    ).toBe("Books");
  });

  it("stores a credential, connects and queues a sync", async () => {
    const { http, db } = world();
    const stored = await http.post(`/integrations/${id(9001)}/credential`, {
      secret: '{"access_token":"fixture"}',
      kind: "OAuth Token",
    });
    const after = (await expectContract(
      await success(stored),
      "integrations.storeCredential",
    )) as Row;
    expect(after["credential_kind"]).toBe("OAuth Token");
    expect(JSON.stringify(after)).not.toContain("fixture");
    const moved = await http.post(`/integrations/${id(9001)}/transitions`, {
      expected_state: "Pending",
      next_state: "Connected",
      reason: "Authorized in Xero.",
    });
    expect(
      ((await expectContract(await success(moved), "integrations.transition")) as Row)[
        "connection_state"
      ],
    ).toBe("Connected");
    const queued = await http.post(`/integrations/${id(9001)}/syncs`, {
      scope: "Ledger Export",
      direction: "Outbound",
    });
    expect(queued.status).toBe(202);
    expect(await expectContract(queued, "integrations.sync")).toEqual({ sync_run_id: id(9600) });
    expect(db.calls.some((c) => JSON.stringify(c).includes("enqueue_integration_sync"))).toBe(true);
  });

  it("answers refusals with the rule and unknown connections with 404", async () => {
    const { http, db } = world();
    db.fail(
      "rpc:transition_integration_connection",
      refusal(
        "integration_credential_required",
        "Store the provider credential before connecting.",
      ),
    );
    const refused = await http.post(`/integrations/${id(9001)}/transitions`, {
      expected_state: "Pending",
      next_state: "Connected",
      reason: "Go.",
    });
    expect(refused.status).toBe(422);
    await expectContract(refused, "integrations.transition");
    const missing = await http.post(`/integrations/${id(9999)}/syncs`, {
      scope: "Ledger Export",
      direction: "Outbound",
    });
    expect(missing.status).toBe(404);
    await expectContract(missing, "integrations.sync");
    const gone = await http.post(`/integrations/${id(9999)}/credential`, {
      secret: "x",
      kind: "API Key",
    });
    expect(gone.status).toBe(404);
    await expectContract(gone, "integrations.storeCredential");
  });

  it("disconnects a connection before removing it", async () => {
    const { http, db } = world();
    const removed = await http.delete(`/integrations/${id(9002)}`);
    expect(removed.status).toBe(204);
    await expectContract(removed, "integrations.delete");
    const row = db.tables["integration_connections"]?.find((r) => r["id"] === id(9002));
    expect(row?.["connection_state"]).toBe("Disconnected");
    expect(row?.["deleted_at"]).toEqual(expect.any(String));
    db.tables["integration_connections"]?.push(
      connection(9003, { connection_state: "Disconnected" }),
    );
    await expectContract(
      await success(http.delete(`/integrations/${id(9003)}`)),
      "integrations.delete",
    );
  });
});

describe("OAuth apps and grants", () => {
  it("serves apps", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/oauth-apps")), "oauthApps.list");
    await expectContract(await success(http.get(`/oauth-apps/${id(9101)}`)), "oauthApps.get");
    const made = await http.post("/oauth-apps", {
      name: "Show Planner",
      redirect_uri: "https://planner.example.com/callback",
    });
    await expectContract(await success(made), "oauthApps.create");
    const renamed = await http.patch(`/oauth-apps/${id(9101)}`, { name: "Show Planner Two" });
    await expectContract(await success(renamed), "oauthApps.update");
    await expectContract(await success(http.delete(`/oauth-apps/${id(9101)}`)), "oauthApps.delete");
  });

  it("serves grants and revokes one by deleting it", async () => {
    const { http, db } = world();
    await expectContract(await success(http.get("/oauth-grants")), "oauthGrants.list");
    await expectContract(await success(http.get(`/oauth-grants/${id(9201)}`)), "oauthGrants.get");
    await expectContract(
      await success(http.delete(`/oauth-grants/${id(9201)}`)),
      "oauthGrants.delete",
    );
    expect(db.tables["oauth_grants"]?.[0]?.["deleted_at"]).toEqual(expect.any(String));
  });
});

describe("SCIM group mappings", () => {
  it("serves mappings", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/scim-group-mappings")), "scimGroupMappings.list");
    await expectContract(
      await success(http.get(`/scim-group-mappings/${id(9301)}`)),
      "scimGroupMappings.get",
    );
    const made = await http.post("/scim-group-mappings", {
      identity_provider_id: id(9401),
      idp_group: "event-finance",
      role_id: id(9701),
      team_id: null,
    });
    await expectContract(await success(made), "scimGroupMappings.create");
    const regrouped = await http.patch(`/scim-group-mappings/${id(9301)}`, { idp_group: "crew" });
    await expectContract(await success(regrouped), "scimGroupMappings.update");
    await expectContract(
      await success(http.delete(`/scim-group-mappings/${id(9301)}`)),
      "scimGroupMappings.delete",
    );
  });
});
