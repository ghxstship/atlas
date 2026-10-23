import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  failureOf,
  mintOwnerToken,
  OWNER_TOKEN_SECONDS,
  runAutomationJobs,
  summarize,
  supabaseAutomationRunStore,
  type AutomationRunStore,
  type BegunAction,
  type BeginOutcome,
  type FinishOutcome,
  type StepRecord,
} from "../src/automation-runner.ts";

const RUN = "0192f1e2-7c3a-7b4d-9e8f-000000091101";
const JOB = "0192f1e2-7c3a-7b4d-9e8f-000000091102";
const RECORD = "0192f1e2-7c3a-7b4d-9e8f-000000091103";
const PROJECT = "0192f1e2-7c3a-7b4d-9e8f-000000091104";
const ROOT = "0192f1e2-7c3a-7b4d-9e8f-000000091105";
const PERSON = "0192f1e2-7c3a-7b4d-9e8f-000000091106";
// A throwaway key built at run time for the test only; no real secret is used or stored.
const SIGNING_KEY = Array.from({ length: 48 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(
  "",
);
const API = "https://atlas.example.test/api/v1";

const event = {
  id: "e1",
  type: "record.created",
  project_id: PROJECT,
  subject: { table: "records", id: RECORD },
  data: { title: "Call the venue", record_kind: "Task" },
};

function begun(actions: BegunAction[], completed: number[] = []): BeginOutcome {
  return {
    outcome: "run",
    run_id: RUN,
    org_id: "org-1",
    automation_id: "auto-1",
    automation_name: "Pick up tasks",
    owner_person_id: PERSON,
    owner_user_id: "user-1",
    depth: 0,
    event,
    actions,
    completed,
  };
}

interface Finished {
  readonly outcome: FinishOutcome;
  readonly code: string | null;
  readonly message: string | null;
}

function store(outcome: BeginOutcome | (() => Promise<BeginOutcome>)) {
  const steps: StepRecord[] = [];
  const finished: Finished[] = [];
  const s: AutomationRunStore = {
    claim: async () => [{ jobId: JOB, runId: RUN }],
    begin: typeof outcome === "function" ? outcome : async () => outcome,
    recordStep: async (step) => {
      steps.push(step);
    },
    finish: async (_run, _job, o, code, message) => {
      finished.push({ outcome: o, code, message });
      return o === "succeeded" ? "Succeeded" : o === "retry" ? "Retrying" : "Failed";
    },
  };
  return { s, steps, finished };
}

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Route = (seen: Seen) => { status: number; body?: unknown } | Promise<never>;

function api(routes: Record<string, Route>) {
  const seen: Seen[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const entry: Seen = {
      method: String(init.method),
      url,
      headers: init.headers as Record<string, string>,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    seen.push(entry);
    const path = url.slice(API.length).split("?")[0] as string;
    const route = routes[`${entry.method} ${path}`];
    if (route === undefined) return new Response(JSON.stringify({ status: 404 }), { status: 404 });
    const answer = await route(entry);
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), {
      status: answer.status,
    });
  };
  return { fetch, seen };
}

const deps = (
  s: AutomationRunStore,
  fetch: (url: string, init: RequestInit) => Promise<Response>,
) => ({
  store: s,
  fetch,
  apiBaseUrl: `${API}/`,
  signingKey: SIGNING_KEY,
  issuer: "http://127.0.0.1:54321/auth/v1",
  worker: "test-worker",
  now: () => Date.parse("2026-10-21T12:00:00Z"),
});

function claims(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split(".")[1] as string, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

describe("the owner's token", () => {
  it("is an HS256 session of the owner bound to the org and marked with the run", async () => {
    const token = await mintOwnerToken({
      userId: "user-1",
      orgId: "org-1",
      automationId: "auto-1",
      runId: RUN,
      signingKey: SIGNING_KEY,
      issuer: "iss",
      nowSeconds: 1000,
    });
    const [head, payload, signature] = token.split(".") as [string, string, string];
    expect(createHmac("sha256", SIGNING_KEY).update(`${head}.${payload}`).digest("base64url")).toBe(
      signature,
    );
    expect(claims(token)).toEqual({
      iss: "iss",
      sub: "user-1",
      aud: "authenticated",
      role: "authenticated",
      iat: 1000,
      exp: 1000 + OWNER_TOKEN_SECONDS,
      org_id: "org-1",
      is_anonymous: false,
      amr: [{ method: "xos_automation", timestamp: 1000 }],
      xos_automation_id: "auto-1",
      xos_automation_run_id: RUN,
    });
    await expect(
      mintOwnerToken({
        userId: "u",
        orgId: "o",
        automationId: "a",
        runId: "r",
        signingKey: "short",
        issuer: "i",
        nowSeconds: 1,
      }),
    ).rejects.toThrow(/too short/);
  });
});

describe("a pass of the worker", () => {
  it("creates the Task under the project's root and notifies, as the owner, with idempotency keys", async () => {
    const { s, steps, finished } = store(
      begun([
        {
          position: 1,
          action_id: "a1",
          type: "create_task",
          title: "Review {{data.title}}",
          phase_code: "SCP",
          xyz: "Y",
          due_at: "2026-10-23T21:00:00Z",
        },
        {
          position: 2,
          action_id: "a2",
          type: "notify",
          recipient_person_id: PERSON,
          title: "New task",
          body: "{{data.title}} needs a look",
        },
      ]),
    );
    const { fetch, seen } = api({
      "GET /scope-nodes": () => ({ status: 200, body: { data: [{ id: ROOT }] } }),
      "POST /records": () => ({
        status: 201,
        body: {
          id: "new-task",
          record_state: "Proposed",
          title: "Review Call the venue",
          extra: 1,
        },
      }),
      [`POST /automation-runs/${RUN}/notices`]: () => ({
        status: 201,
        body: { notification_id: "n1" },
      }),
    });
    expect(await runAutomationJobs(deps(s, fetch))).toEqual([
      { runId: RUN, outcome: "run", status: "Succeeded", errorCode: null },
    ]);
    expect(seen[0]?.url).toContain("filter%5Bproject_id%5D%5Beq%5D=" + PROJECT);
    expect(seen[0]?.url).toContain("filter%5Bparent_id%5D%5Bis_null%5D=true");
    expect(seen[1]?.body).toEqual({
      scope_node_id: ROOT,
      record_kind: "Task",
      title: "Review Call the venue",
      phase_code: "SCP",
      xyz: "Y",
      external_visibility: [],
      due_at: "2026-10-23T21:00:00Z",
    });
    expect(seen[1]?.headers["Idempotency-Key"]).toBe(`automation-${RUN}-1`);
    expect(seen[2]?.body).toEqual({
      recipient_person_id: PERSON,
      title: "New task",
      body: "Call the venue needs a look",
    });
    const token = (seen[1]?.headers["Authorization"] ?? "").replace("Bearer ", "");
    expect(claims(token)).toMatchObject({
      sub: "user-1",
      org_id: "org-1",
      xos_automation_run_id: RUN,
    });
    expect(steps.map((x) => [x.position, x.status, x.operationId, x.httpStatus])).toEqual([
      [1, "Succeeded", "records.create", 201],
      [2, "Succeeded", "automationRuns.notify", 201],
    ]);
    expect(steps[0]?.response).toEqual({
      id: "new-task",
      record_state: "Proposed",
      title: "Review Call the venue",
    });
    expect(finished).toEqual([{ outcome: "succeeded", code: null, message: null }]);
  });

  it("skips steps a retried run already finished and moves, assigns, comments and sends the webhook", async () => {
    const { s, steps } = store(
      begun(
        [
          { position: 1, action_id: "a1", type: "add_comment", body: "Done before" },
          {
            position: 2,
            action_id: "a2",
            type: "update_status",
            to_state: "Blocked",
            body: "Waiting on {{data.title}}",
          },
          { position: 3, action_id: "a3", type: "assign", assignee_person_id: PERSON },
          { position: 4, action_id: "a4", type: "add_comment", body: "Picked up {{data.title}}." },
          { position: 5, action_id: "a5", type: "call_webhook", webhook_endpoint_id: "w1" },
        ],
        [1],
      ),
    );
    const { fetch, seen } = api({
      [`GET /records/${RECORD}`]: () => ({
        status: 200,
        body: { id: RECORD, record_state: "Ready" },
      }),
      [`POST /records/${RECORD}/transitions`]: () => ({
        status: 200,
        body: { id: RECORD, record_state: "Blocked" },
      }),
      [`PATCH /records/${RECORD}`]: () => ({ status: 200, body: { id: RECORD } }),
      "POST /comments/on-subject": () => ({
        status: 201,
        body: { id: "c1", comment_thread_id: "t1" },
      }),
      [`POST /automation-runs/${RUN}/webhook-deliveries`]: () => ({
        status: 201,
        body: { webhook_delivery_id: "d1" },
      }),
    });
    await runAutomationJobs(deps(s, fetch));
    expect(seen.map((x) => `${x.method} ${x.url.slice(API.length)}`)).toEqual([
      `GET /records/${RECORD}?fields=id,record_state`,
      `POST /records/${RECORD}/transitions`,
      `PATCH /records/${RECORD}`,
      "POST /comments/on-subject",
      `POST /automation-runs/${RUN}/webhook-deliveries`,
    ]);
    expect(seen[1]?.body).toEqual({
      expected_state: "Ready",
      to_state: "Blocked",
      blocker_text: "Waiting on Call the venue",
    });
    expect(seen[2]?.headers["If-Match"]).toBe("*");
    expect(seen[3]?.body).toEqual({
      subject_table: "records",
      subject_id: RECORD,
      body: "Picked up Call the venue.",
    });
    expect(steps.map((x) => x.position)).toEqual([2, 3, 4, 5]);
  });

  it("skips a status change the record already has", async () => {
    const { s, steps } = store(
      begun([
        {
          position: 1,
          action_id: "a1",
          type: "update_status",
          to_state: "Deferred",
          body: "Later",
        },
      ]),
    );
    const { fetch, seen } = api({
      [`GET /records/${RECORD}`]: () => ({
        status: 200,
        body: { id: RECORD, record_state: "Deferred" },
      }),
    });
    await runAutomationJobs(deps(s, fetch));
    expect(seen).toHaveLength(1);
    expect(steps[0]?.status).toBe("Skipped");
  });

  it("sends Deferred with its replan reason", async () => {
    const { s } = store(
      begun([
        {
          position: 1,
          action_id: "a1",
          type: "update_status",
          to_state: "Deferred",
          body: "Next week",
        },
      ]),
    );
    const { fetch, seen } = api({
      [`GET /records/${RECORD}`]: () => ({ status: 200, body: { record_state: "Active" } }),
      [`POST /records/${RECORD}/transitions`]: () => ({ status: 200, body: {} }),
    });
    await runAutomationJobs(deps(s, fetch));
    expect(seen[1]?.body).toEqual({
      expected_state: "Active",
      to_state: "Deferred",
      replan_reason: "Next week",
    });
  });

  it.each([
    [503, { title: "Service Unavailable" }, "retry", "api_unavailable"],
    [429, { title: "Too Many Requests" }, "retry", "api_rate_limited"],
    [403, { detail: "Forbidden" }, "refused", "owner_access_refused"],
    [401, {}, "refused", "owner_access_refused"],
    [
      422,
      { detail: "A Task title starts with an imperative verb.", rule: "record_title_grammar" },
      "failed",
      "record_title_grammar",
    ],
    [404, null, "failed", "http_404"],
  ] as const)("an API answer of %i is %s", async (status, body, outcome, code) => {
    const { s, steps, finished } = store(
      begun([{ position: 1, action_id: "a1", type: "add_comment", body: "Hi" }]),
    );
    const { fetch } = api({ "POST /comments/on-subject": () => ({ status, body }) });
    await runAutomationJobs(deps(s, fetch));
    expect(finished[0]).toMatchObject({ outcome, code });
    expect(steps[0]).toMatchObject({ status: "Failed", errorCode: code, httpStatus: status });
  });

  it("retries when the API cannot be reached, and stops at the first failure", async () => {
    const { s, steps, finished } = store(
      begun([
        { position: 1, action_id: "a1", type: "add_comment", body: "Hi" },
        { position: 2, action_id: "a2", type: "add_comment", body: "Never sent" },
      ]),
    );
    const fetch = async () => {
      throw new TypeError("connection refused");
    };
    await runAutomationJobs(deps(s, fetch));
    expect(finished[0]).toMatchObject({ outcome: "retry", code: "api_unreachable" });
    expect(steps).toHaveLength(1);
  });

  it.each([
    [
      "update_status on a non-record subject",
      { ...event, subject: { table: "shipments", id: "s1" } },
      { type: "update_status", to_state: "Complete" },
      "automation_subject_not_record",
    ],
    [
      "a Task without a project",
      { ...event, project_id: null },
      { type: "create_task", title: "Call", phase_code: "SCP", xyz: "Y" },
      "automation_no_project",
    ],
    [
      "a comment with no subject",
      { type: "x" },
      { type: "add_comment", body: "Hi" },
      "automation_no_subject",
    ],
    [
      "a title that fills in empty",
      event,
      { type: "notify", recipient_person_id: PERSON, title: "{{data.missing}}" },
      "automation_text_empty",
    ],
    ["an unknown action", event, { type: "send_fax" }, "automation_action_unknown"],
  ])("fails for good on %s", async (_name, ev, action, code) => {
    const outcome = {
      ...(begun([{ position: 1, action_id: "a1", ...action } as BegunAction]) as object),
      event: ev,
    } as BeginOutcome;
    const { s, finished } = store(outcome);
    const { fetch } = api({});
    await runAutomationJobs(deps(s, fetch));
    expect(finished[0]).toMatchObject({ outcome: "failed", code });
  });

  it("fails a Task whose project the owner cannot see", async () => {
    const { s, finished } = store(
      begun([
        {
          position: 1,
          action_id: "a1",
          type: "create_task",
          title: "Call",
          phase_code: "SCP",
          xyz: "Y",
        },
      ]),
    );
    const { fetch } = api({ "GET /scope-nodes": () => ({ status: 200, body: { data: [] } }) });
    await runAutomationJobs(deps(s, fetch));
    expect(finished[0]).toMatchObject({ outcome: "failed", code: "automation_project_unknown" });
  });

  it("does nothing for a run the database settled first", async () => {
    const { s, steps, finished } = store({ outcome: "refused", error_code: "owner_left_org" });
    const { fetch, seen } = api({});
    expect(await runAutomationJobs(deps(s, fetch))).toEqual([
      { runId: RUN, outcome: "refused", status: null, errorCode: "owner_left_org" },
    ]);
    expect([seen.length, steps.length, finished.length]).toEqual([0, 0, 0]);
  });

  it("hands a run back to the queue when the ledger cannot be written", async () => {
    const { s, finished } = store(async () => {
      throw new Error("database unavailable");
    });
    const { fetch } = api({});
    expect(await runAutomationJobs(deps(s, fetch))).toEqual([
      { runId: RUN, outcome: "error", status: null, errorCode: "worker_error" },
    ]);
    expect(finished[0]).toMatchObject({ outcome: "retry", code: "worker_error" });
  });
});

describe("answers and the ledger", () => {
  it("keeps only identifying fields of an answer", () => {
    expect(summarize({ id: "x", secret: "y", status: 201 })).toEqual({ id: "x", status: 201 });
    expect(summarize([1])).toBeNull();
    expect(summarize({ other: 1 })).toBeNull();
    expect(failureOf({ status: 409, body: null }).kind).toBe("retry");
    expect(failureOf({ status: 500, body: { title: "Oops" } }).message).toBe("Oops");
    expect(failureOf({ status: 400, body: { rule: "Bad-Rule" } }).code).toBe("bad_rule");
  });

  it("calls the 0510 and 1481 RPCs through the service client", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const answers: Record<string, unknown> = {
      claim_jobs: [{ id: JOB, subject_id: RUN }],
      begin_automation_run: { outcome: "skipped", error_code: "automation_off" },
      record_automation_step: "step-1",
      finish_automation_run: "Succeeded",
    };
    const client = {
      schema: () => ({
        rpc: async (fn: string, args: Record<string, unknown>) => {
          calls.push([fn, args]);
          return fn === "fail"
            ? { data: null, error: { message: "boom" } }
            : { data: answers[fn], error: null };
        },
      }),
    };
    const s = supabaseAutomationRunStore(client as never);
    expect(await s.claim("w", 5)).toEqual([{ jobId: JOB, runId: RUN }]);
    expect(await s.begin(RUN, JOB)).toEqual({ outcome: "skipped", error_code: "automation_off" });
    await s.recordStep({
      runId: RUN,
      position: 1,
      actionId: "a1",
      actionType: "notify",
      operationId: "automationRuns.notify",
      status: "Succeeded",
      request: { title: "x" },
      response: null,
      httpStatus: 201,
      errorCode: null,
      errorMessage: null,
      startedAt: "2026-10-21T12:00:00Z",
      durationMs: 3,
    });
    expect(await s.finish(RUN, JOB, "succeeded", null, null)).toBe("Succeeded");
    expect(calls.map(([fn]) => fn)).toEqual([
      "claim_jobs",
      "begin_automation_run",
      "record_automation_step",
      "finish_automation_run",
    ]);
    expect(calls[0]?.[1]).toEqual({ p_worker: "w", p_job_kind: "automation.run", p_limit: 5 });
    const failing = supabaseAutomationRunStore({
      schema: () => ({ rpc: async () => ({ data: null, error: { message: "boom" } }) }),
    } as never);
    await expect(failing.claim("w", 1)).rejects.toThrow("claim_jobs: boom");
    const malformed = supabaseAutomationRunStore({
      schema: () => ({ rpc: async () => ({ data: [{ id: 7 }], error: null }) }),
    } as never);
    await expect(malformed.claim("w", 1)).rejects.toThrow(/Expected text/);
  });
});
