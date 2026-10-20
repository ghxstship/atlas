import { describe, expect, it } from "vitest";
import type { ChatRequestDeps } from "../src/connectors/communication/index.ts";
import { StoreError } from "../src/framework/db.ts";
import { integrationsTranslator } from "../src/framework/messages.ts";
import type { JobQueue } from "../src/framework/runner.ts";
import {
  runInboundEvents,
  supabaseInboundEventStore,
  type EnqueueResult,
  type InboundEvent,
  type InboundEventStore,
} from "../src/inbound/worker.ts";
import { runIntegrationRuntime } from "../src/runtime.ts";
import { bodyOf, dbError, okData, recordingDb, scriptedHttp } from "./doubles.ts";

const t = integrationsTranslator("en-US");
const ORIGIN = "https://atlas.example.com";

function chat(visible = true): ChatRequestDeps {
  return {
    source: {
      routedEvents: async () => [],
      findConnection: async () => "conn-slack",
      resolveMember: async () => ({ personId: "p", userId: "u-dave", orgId: "o" }),
    },
    translate: t,
    clientFor: async () =>
      recordingDb({
        "from:projects": [okData({ id: "prj" }), okData({ id: "prj" })],
        "from:records": [
          okData(
            visible ? { title: "Load In", record_kind: "Task", record_state: "Active" } : null,
          ),
          okData(
            visible ? { title: "Load In", record_kind: "Task", record_state: "Active" } : null,
          ),
        ],
      }).db,
  };
}

function events(list: InboundEvent[], enqueue: EnqueueResult = { runId: "run-1" }) {
  const log: string[] = [];
  const store: InboundEventStore = {
    claim: async (id) => {
      const event = list.find((e) => e.id === id);
      if (!event)
        throw new StoreError({
          kind: "refusal",
          rule: "integration_inbound_not_pending",
          message: "x",
        });
      return event;
    },
    complete: async (id, outcome) => {
      log.push(`complete ${id}: ${outcome}`);
    },
    fail: async (id, code, _message, retryable) => {
      log.push(`fail ${id}: ${code} ${retryable}`);
      return retryable ? "Retrying" : "Dead Letter";
    },
    enqueueSync: async (connection, scope, key) => {
      log.push(`enqueue ${connection} ${scope} ${key}`);
      return enqueue;
    },
    credential: async () => '{"access_token":"xoxb-fixture"}',
  };
  return { store, log };
}

function queueOf(ids: string[]) {
  const finished: [string, boolean, string | null][] = [];
  const queue: JobQueue = {
    claim: async () => ids.map((id, i) => ({ id: `job-${i}`, subjectId: id, attempts: 1 })),
    finish: async (id, ok, error) => {
      finished.push([id, ok, error]);
      return ok ? "Succeeded" : "Queued";
    },
  };
  return { queue, finished };
}

const notice = (overrides: Partial<InboundEvent> = {}): InboundEvent => ({
  id: "ev-1",
  connectionId: "conn-xero",
  providerCode: "xero",
  kind: "Change Notice",
  payload: { scope: "Payment Sync" },
  attempt: 1,
  ...overrides,
});

const unfurl = (payload: Record<string, unknown> = {}): InboundEvent => ({
  id: "ev-2",
  connectionId: "conn-slack",
  providerCode: "slack",
  kind: "Link Unfurl",
  payload: {
    team_id: "T0NORTH",
    user: "U0DAVE",
    channel: "C0PROD",
    message_ts: "1.2",
    links: [`${ORIGIN}/o/work?peek=NWL-12`, "https://elsewhere.test/x"],
    ...payload,
  },
  attempt: 1,
});

describe("inbound worker: change notices", () => {
  it("queues a sync run with a key per event", async () => {
    const e = events([notice()]);
    const q = queueOf(["ev-1"]);
    const out = await runInboundEvents({
      queue: q.queue,
      events: e.store,
      chat: chat(),
      http: scriptedHttp([]).http,
      atlasOrigin: ORIGIN,
      worker: "w",
    });
    expect(out).toEqual([
      { eventId: "ev-1", result: "processed", outcome: "Queued Payment Sync run run-1." },
    ]);
    expect(e.log).toEqual([
      "enqueue conn-xero Payment Sync inbound:ev-1",
      "complete ev-1: Queued Payment Sync run run-1.",
    ]);
    expect(q.finished).toEqual([["job-0", true, null]]);
  });

  it("is satisfied by a run already on its way and by a connection that is not connected", async () => {
    const busy = events([notice()], { refused: "integration_sync_in_progress", message: "x" });
    await runInboundEvents({
      queue: queueOf(["ev-1"]).queue,
      events: busy.store,
      chat: chat(),
      http: scriptedHttp([]).http,
      atlasOrigin: ORIGIN,
      worker: "w",
    });
    expect(busy.log[1]).toContain("already on its way");
    const paused = events(
      [notice({ providerCode: "google_calendar", payload: { scope: "Calendar Sync" } })],
      {
        refused: "integration_not_connected",
        message: "x",
      },
    );
    await runInboundEvents({
      queue: queueOf(["ev-1"]).queue,
      events: paused.store,
      chat: chat(),
      http: scriptedHttp([]).http,
      atlasOrigin: ORIGIN,
      worker: "w",
    });
    expect(paused.log).toEqual([
      "enqueue conn-xero Calendar Sync inbound:ev-1",
      "complete ev-1: The connection is not Connected, so no sync was queued.",
    ]);
  });

  it("dead-letters a notice with an unknown scope or another refusal", async () => {
    const bad = events([notice({ payload: { scope: "Calendar Sync" } })]);
    const out = await runInboundEvents({
      queue: queueOf(["ev-1"]).queue,
      events: bad.store,
      chat: chat(),
      http: scriptedHttp([]).http,
      atlasOrigin: ORIGIN,
      worker: "w",
    });
    expect(out).toEqual([
      { eventId: "ev-1", result: "dead letter", code: "inbound_scope_unknown" },
    ]);
    const refused = events([notice()], { refused: "integration_scope_mismatch", message: "no" });
    const out2 = await runInboundEvents({
      queue: queueOf(["ev-1"]).queue,
      events: refused.store,
      chat: chat(),
      http: scriptedHttp([]).http,
      atlasOrigin: ORIGIN,
      worker: "w",
    });
    expect(out2[0]).toMatchObject({ result: "dead letter", code: "integration_scope_mismatch" });
    const unknownProvider = events([notice({ providerCode: "nobody" })]);
    const out3 = await runInboundEvents({
      queue: queueOf(["ev-1"]).queue,
      events: unknownProvider.store,
      chat: chat(),
      http: scriptedHttp([]).http,
      atlasOrigin: ORIGIN,
      worker: "w",
    });
    expect(out3[0]).toMatchObject({ code: "inbound_scope_unknown" });
  });
});

describe("inbound worker: Slack unfurls", () => {
  it("unfurls the record links the person can see through chat.unfurl", async () => {
    const e = events([unfurl()]);
    const http = scriptedHttp([
      { match: "POST https://slack.com/api/chat.unfurl", respond: () => ({ json: { ok: true } }) },
    ]);
    const out = await runInboundEvents({
      queue: queueOf(["ev-2"]).queue,
      events: e.store,
      chat: chat(),
      http: http.http,
      atlasOrigin: ORIGIN,
      worker: "w",
    });
    expect(out).toEqual([
      { eventId: "ev-2", result: "processed", outcome: "Unfurled 1 record link." },
    ]);
    expect(http.requests[0]?.headers?.["authorization"]).toBe("Bearer xoxb-fixture");
    expect(bodyOf(http.requests[0])).toEqual({
      channel: "C0PROD",
      ts: "1.2",
      unfurls: { [`${ORIGIN}/o/work?peek=NWL-12`]: { text: "NWL-12 Load In: Task, Active." } },
    });
  });

  it("uses the unfurl id when Slack sends one, and unfurls several links", async () => {
    const e = events([
      unfurl({
        unfurl_id: "U1",
        source: "composer",
        links: [`${ORIGIN}/a?peek=NWL-1`, `${ORIGIN}/b?peek=NWL-2`],
      }),
    ]);
    const http = scriptedHttp([
      { match: "POST https://slack.com/api/chat.unfurl", respond: () => ({ json: { ok: true } }) },
    ]);
    const out = await runInboundEvents({
      queue: queueOf(["ev-2"]).queue,
      events: e.store,
      chat: chat(),
      http: http.http,
      atlasOrigin: ORIGIN,
      worker: "w",
    });
    expect(out[0]).toMatchObject({ outcome: "Unfurled 2 record links." });
    expect(bodyOf(http.requests[0])).toMatchObject({ unfurl_id: "U1", source: "composer" });
  });

  it("does nothing for links no one can see or events without links", async () => {
    const hidden = events([unfurl()]);
    const out = await runInboundEvents({
      queue: queueOf(["ev-2"]).queue,
      events: hidden.store,
      chat: chat(false),
      http: scriptedHttp([]).http,
      atlasOrigin: ORIGIN,
      worker: "w",
    });
    expect(out[0]).toMatchObject({ outcome: "No link named a record the person can see." });
    const empty = events([unfurl({ links: [] })]);
    const out2 = await runInboundEvents({
      queue: queueOf(["ev-2"]).queue,
      events: empty.store,
      chat: chat(),
      http: scriptedHttp([]).http,
      atlasOrigin: ORIGIN,
      worker: "w",
    });
    expect(out2[0]).toMatchObject({ outcome: "No record links to unfurl." });
  });

  it("retries a rate limit and dead-letters a revoked token", async () => {
    const limited = events([unfurl()]);
    const rate = scriptedHttp([
      {
        match: "POST https://slack.com",
        respond: () => ({ json: { ok: false, error: "ratelimited" } }),
      },
    ]);
    const out = await runInboundEvents({
      queue: queueOf(["ev-2"]).queue,
      events: limited.store,
      chat: chat(),
      http: rate.http,
      atlasOrigin: ORIGIN,
      worker: "w",
    });
    expect(out[0]).toEqual({ eventId: "ev-2", result: "retrying", code: "provider_rate_limited" });
    const revoked = events([unfurl()]);
    const gone = scriptedHttp([
      { match: "POST https://slack.com", respond: () => ({ json: { ok: false } }) },
    ]);
    const out2 = await runInboundEvents({
      queue: queueOf(["ev-2"]).queue,
      events: revoked.store,
      chat: chat(),
      http: gone.http,
      atlasOrigin: ORIGIN,
      worker: "w",
    });
    expect(out2[0]).toMatchObject({ result: "dead letter", code: "provider_rejected" });
  });
});

describe("inbound worker: jobs", () => {
  it("skips an event that is no longer pending and keeps a job whose outcome could not be recorded", async () => {
    const e = events([]);
    const q = queueOf(["missing"]);
    expect(
      await runInboundEvents({
        queue: q.queue,
        events: e.store,
        chat: chat(),
        http: scriptedHttp([]).http,
        atlasOrigin: ORIGIN,
        worker: "w",
      }),
    ).toEqual([
      { eventId: "missing", result: "skipped", reason: "integration_inbound_not_pending" },
    ]);
    const broken = events([notice()]);
    const failing: InboundEventStore = {
      ...broken.store,
      complete: () => Promise.reject(new Error("database unreachable")),
    };
    const q2 = queueOf(["ev-1"]);
    const out = await runInboundEvents({
      queue: q2.queue,
      events: failing,
      chat: chat(),
      http: scriptedHttp([]).http,
      atlasOrigin: ORIGIN,
      worker: "w",
    });
    expect(out).toEqual([{ eventId: "ev-1", result: "skipped", reason: "runner_error" }]);
    expect(q2.finished).toEqual([["job-0", false, "database unreachable"]]);
    const crashing: InboundEventStore = {
      ...broken.store,
      claim: () => Promise.reject("socket closed"),
    };
    const q3 = queueOf(["ev-1"]);
    await runInboundEvents({
      queue: q3.queue,
      events: crashing,
      chat: chat(),
      http: scriptedHttp([]).http,
      atlasOrigin: ORIGIN,
      worker: "w",
    });
    expect(q3.finished[0]).toEqual(["job-0", false, "socket closed"]);
  });
});

describe("inbound event store", () => {
  it("calls the RPCs of migrations 1400 and 0600", async () => {
    const r = recordingDb({
      "rpc:claim_integration_inbound_event": [
        okData({
          id: "e",
          integration_connection_id: "c",
          provider_code: "xero",
          inbound_kind: "Change Notice",
          payload: null,
          attempt: 1,
        }),
      ],
      "rpc:complete_integration_inbound_event": [okData(null)],
      "rpc:fail_integration_inbound_event": [okData("Retrying")],
      "rpc:enqueue_integration_sync": [
        okData("run-9"),
        dbError("XR001", "integration_sync_in_progress: busy", "integration_sync_in_progress"),
        dbError("P0001", "boom"),
      ],
      "rpc:read_integration_credential": [okData("token")],
    });
    const store = supabaseInboundEventStore(r.db);
    expect(await store.claim("e")).toEqual({
      id: "e",
      connectionId: "c",
      providerCode: "xero",
      kind: "Change Notice",
      payload: {},
      attempt: 1,
    });
    await store.complete("e", "done");
    expect(await store.fail("e", "c", "m", true)).toBe("Retrying");
    expect(await store.enqueueSync("c", "Calendar Sync", "k")).toEqual({ runId: "run-9" });
    expect(await store.enqueueSync("c", "Payment Sync", "k")).toEqual({
      refused: "integration_sync_in_progress",
      message: "busy",
    });
    await expect(store.enqueueSync("c", "Payment Sync", "k")).rejects.toThrow("boom");
    expect(await store.credential("c")).toBe("token");
    const enqueue = r.calls.filter((c) => c.target === "rpc:enqueue_integration_sync");
    expect(enqueue[0]?.steps[0]).toEqual([
      "args",
      [
        {
          p_connection_id: "c",
          p_scope: "Calendar Sync",
          p_direction: "Two Way",
          p_idempotency_key: "k",
        },
      ],
    ]);
    expect((enqueue[1]?.steps[0]?.[1][0] as Record<string, unknown>)["p_direction"]).toBe(
      "Inbound",
    );
  });
});

describe("integration runtime", () => {
  it("runs sync, inbound and warehouse passes and reports a part that could not run", async () => {
    const db = recordingDb({
      "rpc:claim_jobs": [okData([]), okData([]), okData([])],
      "rpc:queue_due_warehouse_deliveries": [dbError("P0001", "warehouse catalog missing")],
    }).db;
    const summary = await runIntegrationRuntime(
      {
        db,
        canon: recordingDb({}).db,
        storage: {
          from: () => ({
            upload: async () => ({ error: null }),
            download: async () => ({ data: new Blob([""]), error: null }),
          }),
        },
        http: scriptedHttp([]).http,
        resolve: async () => ["93.184.216.34"],
        translate: t,
        chat: chat(),
        atlasOrigin: ORIGIN,
      },
      "w",
    );
    expect(summary.sync).toEqual([]);
    expect(summary.inbound).toEqual([]);
    expect(summary.warehouse).toEqual({ queued: 0, outcomes: [] });
    expect(summary.errors).toEqual([{ part: "warehouse", message: "warehouse catalog missing" }]);
  });
});
