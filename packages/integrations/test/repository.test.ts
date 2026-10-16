import { describe, expect, it } from "vitest";
import {
  cancelSync,
  createConnection,
  enqueueSync,
  getConnection,
  listConnections,
  listProviders,
  listSyncErrors,
  listSyncRuns,
  mapExternalId,
  retrySync,
  storeCredential,
  transitionConnection,
  updateConnectionSettings,
} from "../src/framework/repository.ts";
import { dbError, okData, recordingDb } from "./doubles.ts";

describe("integration repository", () => {
  it("lists providers and connections", async () => {
    const { db, calls } = recordingDb({
      "from:integration_providers": [okData([{ provider_code: "xero" }])],
      "from:integration_connections": [okData([]), okData(null), okData({ id: "c1" })],
    });
    expect(await listProviders(db)).toEqual({ ok: true, data: [{ provider_code: "xero" }] });
    expect(await listConnections(db)).toEqual({ ok: true, data: [] });
    expect(await getConnection(db, "missing")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect(await getConnection(db, "c1")).toEqual({ ok: true, data: { id: "c1" } });
    expect(calls[0]?.steps).toContainEqual(["order", ["sort_order"]]);
  });

  it("creates and edits a connection, mapping refusals", async () => {
    const { db, calls } = recordingDb({
      "from:integration_connections": [
        okData({ id: "c1" }),
        dbError(
          "XR001",
          "integration_plan_feature: Connecting xero needs a plan with the upl_export feature.",
          "integration_plan_feature",
        ),
        okData({ id: "c1", display_name: "Books" }),
        okData({ id: "c1" }),
      ],
    });
    expect(
      await createConnection(db, { orgId: "o", providerCode: "xero", displayName: " Books " }),
    ).toEqual({ ok: true, data: { id: "c1" } });
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [
        {
          org_id: "o",
          provider_code: "xero",
          display_name: "Books",
          external_account_id: null,
          provider_settings: {},
        },
      ],
    ]);
    expect(
      await createConnection(db, {
        orgId: "o",
        providerCode: "xero",
        displayName: "B",
        externalAccountId: "t",
        settings: { a: 1 },
      }),
    ).toEqual({
      ok: false,
      error: {
        kind: "refusal",
        rule: "integration_plan_feature",
        message: "Connecting xero needs a plan with the upl_export feature.",
      },
    });
    expect(
      (await updateConnectionSettings(db, "c1", { displayName: " Books ", settings: { a: 2 } })).ok,
    ).toBe(true);
    expect(calls[2]?.steps[0]).toEqual([
      "update",
      [{ display_name: "Books", provider_settings: { a: 2 } }],
    ]);
    expect((await updateConnectionSettings(db, "c1", {})).ok).toBe(true);
  });

  it("calls the credential, transition and sync RPCs", async () => {
    const { db, calls } = recordingDb({
      "rpc:store_integration_credential": [
        okData(null),
        dbError("42501", "org.integrations.manage is required"),
      ],
      "rpc:transition_integration_connection": [okData("ledger-1")],
      "rpc:enqueue_integration_sync": [okData("run-1"), okData("run-2")],
      "rpc:cancel_integration_sync": [okData("l2")],
      "rpc:retry_integration_sync": [okData("l3")],
    });
    expect(await storeCredential(db, "c1", "secret", "OAuth Token")).toEqual({
      ok: true,
      data: null,
    });
    expect(await storeCredential(db, "c1", "secret", "API Key", "2028-01-01T00:00:00Z")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect(await transitionConnection(db, "c1", "Pending", "Connected", "Authorized.")).toEqual({
      ok: true,
      data: "ledger-1",
    });
    expect(
      await enqueueSync(db, {
        connectionId: "c1",
        scope: "Ledger Export",
        direction: "Outbound",
        idempotencyKey: "k",
      }),
    ).toEqual({ ok: true, data: "run-1" });
    await enqueueSync(db, {
      connectionId: "c1",
      scope: "Payroll Export",
      direction: "Outbound",
      idempotencyKey: "k2",
      projectId: "p",
      maxAttempts: 3,
      subject: { entity: "Payroll Run", id: "pr" },
      sourceUri: "s",
    });
    expect(
      calls.filter((c) => c.target === "rpc:enqueue_integration_sync")[1]?.steps[0]?.[1],
    ).toEqual([
      {
        p_connection_id: "c1",
        p_scope: "Payroll Export",
        p_direction: "Outbound",
        p_idempotency_key: "k2",
        p_project_id: "p",
        p_max_attempts: 3,
        p_subject_entity: "Payroll Run",
        p_subject_id: "pr",
        p_source_uri: "s",
      },
    ]);
    expect(await cancelSync(db, "run-1", "No.")).toEqual({ ok: true, data: "l2" });
    expect(await retrySync(db, "run-1", "Again.")).toEqual({ ok: true, data: "l3" });
  });

  it("lists runs and errors and maps identifiers", async () => {
    const { db, calls } = recordingDb({
      "from:integration_sync_runs": [okData([])],
      "from:integration_sync_errors": [okData([])],
      "from:integration_external_ids": [okData({ id: "x" })],
    });
    expect((await listSyncRuns(db, "c1", 999)).ok).toBe(true);
    expect(calls[0]?.steps).toContainEqual(["limit", [200]]);
    expect((await listSyncErrors(db, "run-1")).ok).toBe(true);
    expect(await mapExternalId(db, "c1", "Membership", "m1", " emp-7 ")).toEqual({
      ok: true,
      data: { id: "x" },
    });
    expect(calls[2]?.steps[0]).toEqual([
      "insert",
      [
        {
          integration_connection_id: "c1",
          entity: "Membership",
          local_id: "m1",
          external_id: "emp-7",
        },
      ],
    ]);
  });
});
