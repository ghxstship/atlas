import { describe, expect, it } from "vitest";
import type { Connector } from "../src/framework/connector.ts";
import { connectorRegistry } from "../src/framework/connector.ts";
import { IntegrationError } from "../src/framework/errors.ts";
import { runIntegrationJobs, supabaseJobQueue, type JobQueue } from "../src/framework/runner.ts";
import { supabaseIntegrationStore } from "../src/framework/store.ts";
import { dbError, okData, recordingDb, scriptedHttp } from "./doubles.ts";

const runRow = (overrides: Record<string, unknown> = {}) => ({
  id: "run-1",
  org_id: "org-1",
  integration_connection_id: "conn-1",
  project_id: null,
  sync_scope: "Ledger Export",
  direction: "Outbound",
  sync_run_state: "Running",
  attempt: 1,
  max_attempts: 5,
  cursor_before: null,
  subject_entity: null,
  subject_id: null,
  source_uri: null,
  ...overrides,
});

const connectionRow = (provider = "xero") => ({
  id: "conn-1",
  org_id: "org-1",
  provider_code: provider,
  display_name: "Northwind Xero",
  external_account_id: "tenant-1",
  provider_settings: null,
  connection_state: "Connected",
});

function queueWith(jobs: { id: string; subjectId: string }[]) {
  const finished: { id: string; succeeded: boolean; error: string | null }[] = [];
  const queue: JobQueue = {
    claim: async () => jobs.map((j) => ({ ...j, attempts: 1 })),
    finish: async (id, succeeded, error) => {
      finished.push({ id, succeeded, error });
      return succeeded ? "Succeeded" : "Failed";
    },
  };
  return { queue, finished };
}

const ledgerConnector = (behavior: () => Promise<{ cursor: string }>): Connector => ({
  provider: "xero",
  scopes: ["Ledger Export", "Payment Sync"],
  async sync(context) {
    expect(context.credential?.token).toBe("fixture-token");
    const { cursor } = await behavior();
    return { counts: { read: 2, written: 2, skipped: 0, failed: 0 }, cursorAfter: cursor };
  },
});

describe("integration job runner", () => {
  it("claims the run, runs the connector and completes the run", async () => {
    const { db, calls } = recordingDb({
      "rpc:claim_integration_sync": [okData(runRow())],
      "from:integration_connections": [okData(connectionRow())],
      "rpc:read_integration_credential": [okData("fixture-token")],
      "from:integration_sync_runs": [okData([{ cursor_after: "journal:41" }])],
      "rpc:complete_integration_sync": [okData(null)],
    });
    const { queue, finished } = queueWith([{ id: "job-1", subjectId: "run-1" }]);
    const { http } = scriptedHttp([]);
    let seenCursor: string | null = null;
    const connector: Connector = {
      provider: "xero",
      scopes: ["Ledger Export"],
      async sync(context) {
        seenCursor = context.cursor;
        expect(context.now()).toBeInstanceOf(Date);
        return {
          counts: { read: 1, written: 1, skipped: 0, failed: 0 },
          cursorAfter: "journal:42",
        };
      },
    };
    const outcomes = await runIntegrationJobs({
      queue,
      store: supabaseIntegrationStore(db),
      connectors: connectorRegistry([connector]),
      http,
      worker: "worker-a",
    });
    expect(outcomes).toEqual([{ jobId: "job-1", runId: "run-1", result: "succeeded" }]);
    expect(seenCursor).toBe("journal:41");
    expect(finished).toEqual([{ id: "job-1", succeeded: true, error: null }]);
    expect(calls.find((c) => c.target === "rpc:claim_integration_sync")?.steps[0]?.[1]).toEqual([
      { p_run_id: "run-1", p_job_id: "job-1" },
    ]);
    expect(calls.find((c) => c.target === "rpc:complete_integration_sync")?.steps[0]?.[1]).toEqual([
      {
        p_run_id: "run-1",
        p_items_read: 1,
        p_items_written: 1,
        p_items_skipped: 0,
        p_items_failed: 0,
        p_cursor_after: "journal:42",
      },
    ]);
  });

  it("records a retryable provider failure on the run", async () => {
    const { db, calls } = recordingDb({
      "rpc:claim_integration_sync": [okData(runRow({ cursor_before: "start" }))],
      "from:integration_connections": [okData(connectionRow())],
      "rpc:read_integration_credential": [okData("fixture-token")],
      "rpc:fail_integration_sync": [okData("Retrying")],
    });
    const { queue, finished } = queueWith([{ id: "job-1", subjectId: "run-1" }]);
    const { http } = scriptedHttp([]);
    const outcomes = await runIntegrationJobs({
      queue,
      store: supabaseIntegrationStore(db),
      connectors: connectorRegistry([
        ledgerConnector(() =>
          Promise.reject(new IntegrationError("provider_rate_limited", "429", { retryable: true })),
        ),
      ]),
      http,
      worker: "worker-a",
    });
    expect(outcomes).toEqual([
      { jobId: "job-1", runId: "run-1", result: "retrying", code: "provider_rate_limited" },
    ]);
    expect(finished[0]?.succeeded).toBe(true);
    expect(calls.find((c) => c.target === "rpc:fail_integration_sync")?.steps[0]?.[1]).toEqual([
      {
        p_run_id: "run-1",
        p_error_code: "provider_rate_limited",
        p_error_message: "429",
        p_retryable: true,
        p_connection_error: false,
      },
    ]);
  });

  it("fails the run when no connector or scope fits", async () => {
    const { db } = recordingDb({
      "rpc:claim_integration_sync": [
        okData(runRow()),
        okData(runRow({ sync_scope: "Payment Sync" })),
      ],
      "from:integration_connections": [okData(connectionRow("netsuite")), okData(connectionRow())],
      "rpc:fail_integration_sync": [okData("Failed"), okData("Failed")],
    });
    const { queue } = queueWith([
      { id: "job-1", subjectId: "run-1" },
      { id: "job-2", subjectId: "run-1" },
    ]);
    const { http } = scriptedHttp([]);
    const narrow: Connector = {
      provider: "xero",
      scopes: ["Ledger Export"],
      sync: () => Promise.reject(new Error("unused")),
    };
    const outcomes = await runIntegrationJobs({
      queue,
      store: supabaseIntegrationStore(db),
      connectors: connectorRegistry([narrow]),
      http,
      worker: "worker-a",
    });
    expect(outcomes.map((o) => ("code" in o ? o.code : o.result))).toEqual([
      "connector_missing",
      "scope_unsupported",
    ]);
  });

  it("skips a run the database refuses to claim", async () => {
    const { db } = recordingDb({
      "rpc:claim_integration_sync": [
        dbError(
          "XR001",
          "integration_sync_run_transition_not_allowed: No.",
          "integration_sync_run_transition_not_allowed",
        ),
      ],
    });
    const { queue, finished } = queueWith([{ id: "job-1", subjectId: "run-1" }]);
    const { http } = scriptedHttp([]);
    const outcomes = await runIntegrationJobs({
      queue,
      store: supabaseIntegrationStore(db),
      connectors: new Map(),
      http,
      worker: "worker-a",
    });
    expect(outcomes).toEqual([
      {
        jobId: "job-1",
        runId: "run-1",
        result: "skipped",
        reason: "integration_sync_run_transition_not_allowed",
      },
    ]);
    expect(finished[0]?.succeeded).toBe(true);
  });

  it("keeps the evidence on the job when recording the outcome fails", async () => {
    const { db } = recordingDb({
      "rpc:claim_integration_sync": [dbError("08006", "connection lost")],
    });
    const { queue, finished } = queueWith([{ id: "job-1", subjectId: "run-1" }]);
    const { http } = scriptedHttp([]);
    const outcomes = await runIntegrationJobs({
      queue,
      store: supabaseIntegrationStore(db),
      connectors: new Map(),
      http,
      worker: "w",
    });
    expect(outcomes).toEqual([
      { jobId: "job-1", runId: "run-1", result: "failed", code: "runner_error" },
    ]);
    expect(finished).toEqual([{ id: "job-1", succeeded: false, error: "connection lost" }]);
  });

  it("runs a credential-free connector without reading Vault", async () => {
    const { db, calls } = recordingDb({
      "rpc:claim_integration_sync": [
        okData(runRow({ sync_scope: "Attendance Import", cursor_before: "c" })),
      ],
      "from:integration_connections": [okData(connectionRow("ticketing_csv"))],
      "rpc:complete_integration_sync": [okData(null)],
    });
    const { queue } = queueWith([{ id: "job-1", subjectId: "run-1" }]);
    const { http } = scriptedHttp([]);
    const csv: Connector = {
      provider: "ticketing_csv",
      scopes: ["Attendance Import"],
      async sync(context) {
        expect(context.credential).toBeNull();
        return { counts: { read: 0, written: 0, skipped: 0, failed: 0 }, cursorAfter: null };
      },
    };
    await runIntegrationJobs({
      queue,
      store: supabaseIntegrationStore(db),
      connectors: connectorRegistry([csv]),
      http,
      worker: "w",
      now: () => new Date(0),
    });
    expect(calls.some((c) => c.target === "rpc:read_integration_credential")).toBe(false);
  });
});

describe("job queue and store adapters", () => {
  it("calls claim_jobs and finish_job", async () => {
    const { db, calls } = recordingDb({
      "rpc:claim_jobs": [okData([{ id: "j", subject_id: "r", attempts: 1 }])],
      "rpc:finish_job": [okData("Succeeded")],
    });
    const queue = supabaseJobQueue(db);
    await expect(queue.claim("w", "integration.sync", 5)).resolves.toEqual([
      { id: "j", subjectId: "r", attempts: 1 },
    ]);
    await expect(queue.finish("j", true, null)).resolves.toBe("Succeeded");
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      { p_worker: "w", p_job_kind: "integration.sync", p_limit: 5 },
    ]);
  });

  it("reads and writes the identifier map and item errors", async () => {
    const { db, calls } = recordingDb({
      "from:integration_external_ids": [
        okData([
          {
            entity: "Payment",
            local_id: "p1",
            external_id: "x1",
            external_version: null,
            content_hash: null,
          },
        ]),
      ],
      "rpc:upsert_integration_external_id": [okData("id")],
      "rpc:record_integration_sync_error": [okData("id"), okData("id")],
      "from:integration_sync_runs": [okData([])],
    });
    const store = supabaseIntegrationStore(db);
    await expect(store.externalIds("conn-1", "Payment")).resolves.toEqual([
      {
        entity: "Payment",
        localId: "p1",
        externalId: "x1",
        externalVersion: null,
        contentHash: null,
      },
    ]);
    await store.upsertExternalId("conn-1", {
      entity: "Payment",
      localId: "p1",
      externalId: "x2",
      externalVersion: "v",
      contentHash: null,
    });
    await store.recordItemError("run-1", "bad", "Bad.", {
      entity: "Payment",
      localId: "p1",
      externalId: "x2",
    });
    await store.recordItemError("run-1", "bad", "Bad.");
    await expect(store.lastCursor("conn-1", "Payment Sync")).resolves.toBeNull();
    expect(
      calls.find((c) => c.target === "rpc:upsert_integration_external_id")?.steps[0]?.[1],
    ).toEqual([
      {
        p_connection_id: "conn-1",
        p_entity: "Payment",
        p_local_id: "p1",
        p_external_id: "x2",
        p_external_version: "v",
        p_content_hash: null,
      },
    ]);
    expect(
      calls.filter((c) => c.target === "rpc:record_integration_sync_error")[1]?.steps[0]?.[1],
    ).toEqual([
      {
        p_run_id: "run-1",
        p_error_code: "bad",
        p_error_message: "Bad.",
        p_entity: null,
        p_local_id: null,
        p_external_id: null,
      },
    ]);
  });
});
