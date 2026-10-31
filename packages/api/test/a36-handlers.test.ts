/**
 * Contract tests for A36's handlers (Section 18, gate 5): support sessions, wholesale statements,
 * acting on a notification (the server half of approving from a push notification) and the import dry
 * run and commit request. Requests run through `contractApp`, every response is checked against
 * openapi/v1.json with `expectContract`, and the database is a recording stand-in for supabase-js.
 * Refusals (422) and hidden rows (404) are checked.
 */
import { describe, expect, it } from "vitest";
import { handlers as platformHandlers } from "../src/handlers/platform.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";

type Response = { data: unknown; error: { code: string; message: string; hint?: string } | null };
type Call = { target: string; steps: [string, unknown[]][] };

function fakeDb(queues: Record<string, Response[]>) {
  const calls: Call[] = [];
  const take = (key: string): Response => {
    const next = queues[key]?.shift();
    if (!next) throw new Error(`no queued response for ${key}`);
    return next;
  };
  const builder = (key: string, steps: [string, unknown[]][]) => {
    const response = take(key);
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (resolve: (r: Response) => unknown) => resolve(response);
          return (...args: unknown[]) => {
            steps.push([prop, args]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const db: Record<string, unknown> = {
    from(table: string) {
      const call: Call = { target: `from:${table}`, steps: [] };
      calls.push(call);
      return builder(call.target, call.steps);
    },
    rpc(name: string, args: unknown) {
      const call: Call = { target: `rpc:${name}`, steps: [["args", [args]]] };
      calls.push(call);
      return builder(call.target, call.steps);
    },
  };
  db["schema"] = () => db;
  return { db, calls };
}

const ctx = testContext();
const ORG = ctx.org?.id as string;
const T = "2026-10-16T12:00:00.000Z";
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const ok = (data: unknown): Response => ({ data, error: null });
const refusal = (rule: string): Response => ({
  data: null,
  error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
});
const hidden: Response = { data: null, error: null };
const audit = (n: number) => ({
  id: id(n),
  org_id: ORG,
  created_at: T,
  created_by: null,
  updated_at: T,
  updated_by: null,
});

let keys = 0;
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Idempotency-Key": `a36-contract-${(keys += 1)}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function app(queues: Record<string, Response[]>) {
  const fake = fakeDb(queues);
  return {
    api: contractApp({ handlers: [platformHandlers], db: fake.db as never }),
    calls: fake.calls,
  };
}

const session = {
  ...audit(1),
  grantee_org_id: id(900),
  reason: "Help with the venue import.",
  starts_at: T,
  ends_at: "2026-10-16T16:00:00.000Z",
  ended_at: null,
  ended_by: null,
};
const statement = {
  ...audit(2),
  period_start: "2026-10-01",
  currency_code: "USD",
  wholesale_discount_bps: 2000,
  client_count: 1,
  list_total_minor: 4900,
  wholesale_total_minor: 3920,
  unpriced_count: 0,
};
const notification = {
  ...audit(3),
  kind: "approval.requested",
  recipient_person_id: id(700),
  read_at: null,
  actor_person_id: id(701),
  subject_table: "approval_instances",
  subject_id: id(800),
  project_id: null,
  message_args: { title: "Purchase Order 17" },
  archived_at: null,
};
const importJob = {
  ...audit(4),
  import_mapping_profile_id: null,
  target_code: "counterparties",
  source: "CSV",
  original_filename: "customers.csv",
  storage_object_path: `${id(700)}/${id(701)}.csv`,
  import_status: "Validated",
  mapping_confirmed_at: T,
};

describe("Support sessions", () => {
  it("lists, grants and ends sessions through the RPCs", async () => {
    const { api, calls } = app({
      "from:support_sessions": [
        ok([session]),
        ok(session),
        hidden,
        ok(session),
        ok({ id: session.id }),
        ok({ ...session, ended_at: T, ended_by: id(700) }),
        ok({ id: session.id }),
      ],
      "rpc:grant_support_session": [ok(session.id), refusal("support_session_active")],
      "rpc:end_support_session": [ok(session.id), refusal("support_session_ended")],
    });
    await expectContract(await api.request("/support-sessions"), "supportSessions.list");
    await expectContract(
      await api.request(`/support-sessions/${session.id}`),
      "supportSessions.get",
    );
    expect((await api.request(`/support-sessions/${id(999)}`)).status).toBe(404);
    const granted = await api.request(
      "/support-sessions/grant",
      post({ hours: 4, reason: "Help." }),
    );
    expect(granted.status).toBe(201);
    await expectContract(granted, "supportSessions.grant");
    expect(calls.find((c) => c.target === "rpc:grant_support_session")?.steps[0]?.[1][0]).toEqual({
      p_org_id: ORG,
      p_hours: 4,
      p_reason: "Help.",
    });
    const again = await api.request(
      "/support-sessions/grant",
      post({ hours: 2, reason: "Again." }),
    );
    expect(again.status).toBe(422);
    await expectContract(again, "supportSessions.grant");
    const ended = await api.request(`/support-sessions/${session.id}/end`, post({}));
    await expectContract(ended, "supportSessions.end");
    const twice = await api.request(`/support-sessions/${session.id}/end`, post({}));
    expect(twice.status).toBe(422);
  });
});

describe("Wholesale statements", () => {
  it("lists statements and runs a month", async () => {
    const { api } = app({
      "from:wholesale_statements": [ok([statement]), ok(statement), ok(statement)],
      "rpc:run_wholesale_billing": [ok(statement.id), refusal("wholesale_statement_exists")],
    });
    await expectContract(await api.request("/wholesale-statements"), "wholesaleStatements.list");
    await expectContract(
      await api.request(`/wholesale-statements/${statement.id}`),
      "wholesaleStatements.get",
    );
    const ran = await api.request(
      "/wholesale-statements/run",
      post({ period_start: "2026-10-01" }),
    );
    expect(ran.status).toBe(201);
    await expectContract(ran, "wholesaleStatements.run");
    const billed = await api.request(
      "/wholesale-statements/run",
      post({ period_start: "2026-10-01" }),
    );
    expect(billed.status).toBe(422);
    await expectContract(billed, "wholesaleStatements.run");
  });
});

describe("Acting on a notification", () => {
  it("approves where the notification arrived, and names a refusal", async () => {
    const { api, calls } = app({
      "from:notifications": [
        ok({ id: notification.id }),
        ok({ ...notification, read_at: T, archived_at: T }),
        ok({ id: notification.id }),
        hidden,
      ],
      "rpc:act_on_notification": [ok(notification.id), refusal("approval_rejection_reason")],
    });
    const acted = await api.request(
      `/notifications/${notification.id}/act`,
      post({ action: "approve" }),
    );
    await expectContract(acted, "notifications.act");
    expect(calls.find((c) => c.target === "rpc:act_on_notification")?.steps[0]?.[1][0]).toEqual({
      p_notification_id: notification.id,
      p_action: "approve",
      p_comment: null,
    });
    const refused = await api.request(
      `/notifications/${notification.id}/act`,
      post({ action: "reject" }),
    );
    expect(refused.status).toBe(422);
    await expectContract(refused, "notifications.act");
    expect(
      (await api.request(`/notifications/${id(999)}/act`, post({ action: "done" }))).status,
    ).toBe(404);
  });

  it("accepts an offer and replies to a message from the push action (A127)", async () => {
    const { api, calls } = app({
      "from:notifications": [
        ok({ id: notification.id }),
        ok({ ...notification, read_at: T, archived_at: T }),
        ok({ id: notification.id }),
        ok({ ...notification, read_at: T, archived_at: T }),
      ],
      "rpc:act_on_notification": [ok(notification.id), ok(notification.id)],
    });
    const accepted = await api.request(
      `/notifications/${notification.id}/act`,
      post({ action: "accept" }),
    );
    await expectContract(accepted, "notifications.act");
    const replied = await api.request(
      `/notifications/${notification.id}/act`,
      post({ action: "reply", comment: "On my way." }),
    );
    await expectContract(replied, "notifications.act");
    const steps = calls
      .filter((c) => c.target === "rpc:act_on_notification")
      .flatMap((c) => c.steps);
    expect(steps.map((s) => s[1][0])).toEqual([
      { p_notification_id: notification.id, p_action: "accept", p_comment: null },
      { p_notification_id: notification.id, p_action: "reply", p_comment: "On my way." },
    ]);
    expect(
      (await api.request(`/notifications/${notification.id}/act`, post({ action: "delete" })))
        .status,
    ).toBe(422);
  });
});

describe("Import dry run and commit", () => {
  it("counts the dry run and requests the commit", async () => {
    const { api } = app({
      "from:import_jobs": [
        ok({ id: importJob.id }),
        ok({ id: importJob.id }),
        ok({ ...importJob, import_status: "Committing" }),
        ok({ id: importJob.id }),
      ],
      "rpc:import_dry_run": [
        ok([{ creates: 2, updates: 1, merges: 1, refusals: 1, skipped: 0, pending_reviews: 0 }]),
      ],
      "rpc:request_import_commit": [ok(id(950)), refusal("import_merge_reviews_pending")],
    });
    const dry = await api.request(`/import-jobs/${importJob.id}/dry-run`, post({}));
    await expectContract(dry.clone(), "importJobs.dryRun");
    expect(await dry.json()).toEqual({
      creates: 2,
      updates: 1,
      merges: 1,
      refusals: 1,
      skipped: 0,
      pending_reviews: 0,
    });
    const committed = await api.request(`/import-jobs/${importJob.id}/commit`, post({}));
    expect(committed.status).toBe(201);
    await expectContract(committed, "importJobs.commit");
    const pending = await api.request(`/import-jobs/${importJob.id}/commit`, post({}));
    expect(pending.status).toBe(422);
  });
});
