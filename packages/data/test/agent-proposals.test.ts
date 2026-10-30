import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  bodyFromFields,
  fieldsFromBody,
  getProposalForApply,
  listMcpConnectors,
  listMyAgentProposals,
  proposeAgentChange,
  registerMcpConnector,
} from "../src/agent-proposals.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/** B16 (migration 3052, ADR 0155 D1 and D2): MCP connectors and the proposals they make. */

describe("agent proposals", () => {
  it("turns a body into fields and back, a null clearing a field", () => {
    const fields = fieldsFromBody({ name: "Encore", description: null });
    expect(fields).toEqual([
      { fieldPath: "name", value: "Encore" },
      { fieldPath: "description", value: null },
    ]);
    expect(bodyFromFields(fields)).toEqual({ name: "Encore", description: null });
    expect(fieldsFromBody(undefined)).toEqual([]);
  });

  it("proposes a change with its path, If-Match and fields", async () => {
    const { db, calls } = fakeClient({
      "rpc:propose_agent_change": [
        okResponse([
          { suggestion_id: "s1", expires_at: "2026-11-06T12:00:00Z", org_slug: "northwind-live" },
        ]),
        errorResponse(
          "XR001",
          "agent_outside_grant: This operation is outside the capability groups.",
        ),
      ],
    });
    const client = db as unknown as XosClient;
    const input = {
      operationId: "projects.update",
      operationScopes: ["projects"],
      targetId: "p1",
      summary: "Rename.",
      path: { id: "p1" },
      ifMatch: 'W/"1"',
      fields: [{ fieldPath: "name", value: "Encore" }],
    };
    expect(await proposeAgentChange(client, input)).toEqual({
      ok: true,
      data: { suggestionId: "s1", expiresAt: "2026-11-06T12:00:00Z", orgSlug: "northwind-live" },
    });
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      {
        p_operation_id: "projects.update",
        p_operation_scopes: ["projects"],
        p_target_id: "p1",
        p_summary: "Rename.",
        p_path: { id: "p1" },
        p_if_match: 'W/"1"',
        p_fields: [{ field_path: "name", value: "Encore" }],
      },
    ]);
    const refused = await proposeAgentChange(client, { ...input, targetId: null, ifMatch: null });
    expect(refused.ok === false && refused.error).toMatchObject({ rule: "agent_outside_grant" });
  });

  it("lists what waits for the person and reads one for applying", async () => {
    const row = {
      suggestion_id: "s1",
      oauth_app_id: "a1",
      app_name: "Claude",
      operation_id: "projects.update",
      summary: "Rename.",
      target_id: "p1",
      fields: [
        { field_path: "name", value: "Encore" },
        { field_path: "notes", value: null },
        { bad: true },
      ],
      operation_request: { path: { id: "p1", n: 2, x: { no: 1 } }, if_match: "e1" },
      created_at: "2026-10-30T12:00:00Z",
      expires_at: "2026-11-06T12:00:00Z",
    };
    const { db } = fakeClient({
      "rpc:my_agent_proposals": [okResponse([row])],
      "rpc:agent_proposal_for_apply": [
        okResponse([{ ...row, org_id: "o1", grant_scopes: ["projects"], operation_request: null }]),
        okResponse([]),
      ],
    });
    const client = db as unknown as XosClient;
    const listed = await listMyAgentProposals(client, "o1");
    expect(listed.ok && listed.data[0]).toMatchObject({
      appName: "Claude",
      fields: [
        { fieldPath: "name", value: "Encore" },
        { fieldPath: "notes", value: null },
      ],
      request: { path: { id: "p1", n: 2 }, ifMatch: "e1" },
    });
    const apply = await getProposalForApply(client, "s1");
    expect(apply.ok && apply.data).toMatchObject({
      grantScopes: ["projects"],
      request: { path: {}, ifMatch: null },
    });
    expect(await getProposalForApply(client, "s1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("registers a connector and lists the live ones with their client ids", async () => {
    const { db, calls } = fakeClient({
      "rpc:register_mcp_connector": [okResponse([{ oauth_app_id: "a1", client_id: "c-uuid" }])],
      "from:mcp_connectors": [
        okResponse([
          {
            oauth_app_id: "a1",
            client_kind: "Claude",
            default_scopes: ["home", "projects"],
            created_at: "2026-10-30T12:00:00Z",
            oauth_apps: {
              name: "Claude",
              redirect_uri: "https://claude.ai/api/mcp/auth_callback",
              deleted_at: null,
            },
          },
          {
            oauth_app_id: "a2",
            client_kind: "Other",
            default_scopes: ["home"],
            created_at: "2026-10-30T12:00:00Z",
            oauth_apps: {
              name: "Gone",
              redirect_uri: "https://x.test/cb",
              deleted_at: "2026-10-30T13:00:00Z",
            },
          },
        ]),
      ],
      "rpc:oauth_app_client_ids": [okResponse([{ oauth_app_id: "a1", auth_client_id: "c-uuid" }])],
    });
    const client = db as unknown as XosClient;
    expect(
      await registerMcpConnector(client, {
        orgId: "o1",
        kind: "Claude",
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        defaultScopes: ["home", "projects"],
      }),
    ).toEqual({ ok: true, data: { oauthAppId: "a1", clientId: "c-uuid" } });
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      {
        p_org_id: "o1",
        p_kind: "Claude",
        p_name: "",
        p_redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        p_default_scopes: ["home", "projects"],
      },
    ]);
    const listed = await listMcpConnectors(client, "o1");
    expect(listed.ok && listed.data).toEqual([
      {
        oauthAppId: "a1",
        name: "Claude",
        kind: "Claude",
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        defaultScopes: ["home", "projects"],
        clientId: "c-uuid",
        createdAt: "2026-10-30T12:00:00Z",
      },
    ]);
  });
});
