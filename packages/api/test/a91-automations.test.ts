/**
 * Contract tests for the automation operations (A91, migrations 1480 and 1481, ADR 0047). Requests run through
 * `contractApp` against the in-memory client and every success is checked against openapi/v1.json with
 * `expectContract`. Who may write, plan gating, the fit of actions to triggers, loop protection and failing closed are
 * the database's (pgTAP 1480 and 1481); here the RPCs answer the way the database does, and queued failures stand in
 * for its refusals.
 */
import { describe, expect, it } from "vitest";
import { actionsDocument, conditionsDocument } from "../src/handlers/parts/automations.ts";
import { handlers as platform } from "../src/handlers/platform.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const ME = testContext().personId as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(91000 + n).padStart(12, "0")}`;
const AUTO = id(1);
const RUN = id(2);
const RECORD = id(3);
const EVENT = id(4);

const CONDITIONS = {
  all: [
    { field: "data.record_kind", operator: "eq", value: "Task" },
    { any: [{ field: "data.record_state", operator: "is_null" }] },
  ],
};
const ACTIONS = [
  { type: "add_comment", body: "Picked up {{data.title}}." },
  { type: "notify", recipient_person_id: ME, title: "New task" },
];

function world() {
  const automations: Row[] = [
    tenantRow(AUTO, ORG, {
      name: "Pick up tasks",
      description: null,
      trigger_event_type: "record.created",
      condition_match: "all",
      owner_person_id: ME,
      enabled: true,
      paused_at: null,
      pause_reason: null,
    }),
  ];
  const conditions: Row[] = [
    tenantRow(id(10), ORG, {
      automation_id: AUTO,
      parent_condition_id: null,
      position: 1,
      group_match: null,
      field: "data.record_kind",
      operator: "eq",
      value_text: "Task",
    }),
    tenantRow(id(11), ORG, {
      automation_id: AUTO,
      parent_condition_id: null,
      position: 2,
      group_match: "any",
      field: null,
      operator: null,
      value_text: null,
    }),
    tenantRow(id(12), ORG, {
      automation_id: AUTO,
      parent_condition_id: id(11),
      position: 1,
      group_match: null,
      field: "data.record_state",
      operator: "is_null",
      value_text: null,
    }),
  ];
  const actionRow = (position: number, extra: Row) =>
    tenantRow(id(20 + position), ORG, {
      automation_id: AUTO,
      position,
      title_template: null,
      body_template: null,
      project_id: null,
      phase_code: null,
      xyz: null,
      due_in_days: null,
      to_state: null,
      assignee_person_id: null,
      recipient_person_id: null,
      webhook_endpoint_id: null,
      ...extra,
    });
  const actions: Row[] = [
    actionRow(1, { action_type: "add_comment", body_template: "Picked up {{data.title}}." }),
    actionRow(2, { action_type: "notify", recipient_person_id: ME, title_template: "New task" }),
  ];
  const runs: Row[] = [
    tenantRow(RUN, ORG, {
      automation_id: AUTO,
      domain_event_id: EVENT,
      parent_run_id: null,
      depth: 0,
      run_status: "Failed",
      event_payload: { type: "record.created", subject: { table: "records", id: RECORD } },
      owner_person_id: ME,
      attempts: 5,
      error_code: "api_unavailable",
      error_message: "The API answered 503.",
      started_at: "2026-10-21T12:00:00Z",
      finished_at: "2026-10-21T12:30:00Z",
      duration_ms: 1800000,
    }),
  ];
  const steps: Row[] = [
    tenantRow(id(30), ORG, {
      automation_run_id: RUN,
      automation_action_id: id(21),
      position: 1,
      action_type: "add_comment",
      operation_id: "comments.postOnSubject",
      step_status: "Failed",
      request_body: { body: "Hi" },
      response_body: null,
      http_status: 503,
      error_code: "api_unavailable",
      error_message: "The API answered 503.",
      started_at: "2026-10-21T12:00:00Z",
      finished_at: "2026-10-21T12:00:01Z",
      duration_ms: 1000,
    }),
  ];
  const comments: Row[] = [];
  const db = memoryDb(
    {
      automations,
      automation_conditions: conditions,
      automation_actions: actions,
      automation_runs: runs,
      automation_run_steps: steps,
      comments,
    },
    {
      save_automation: (args) => {
        const existing = automations.find((a) => a["id"] === args["p_automation_id"]);
        if (existing === undefined) {
          automations.push(
            tenantRow(id(5), ORG, {
              name: args["p_name"],
              description: args["p_description"] || null,
              trigger_event_type: args["p_trigger_event_type"],
              condition_match: "all",
              owner_person_id: ME,
              enabled: args["p_enabled"],
              paused_at: null,
              pause_reason: null,
            }),
          );
          actions.push({
            ...actionRow(1, { action_type: "add_comment", body_template: "Hello" }),
            id: id(25),
            automation_id: id(5),
          });
          return id(5);
        }
        if (args["p_name"] !== null) existing["name"] = args["p_name"];
        if (args["p_enabled"] !== null) existing["enabled"] = args["p_enabled"];
        return existing["id"];
      },
      delete_automation: (args) => {
        const row = automations.find((a) => a["id"] === args["p_automation_id"]) as Row;
        row["deleted_at"] = "2026-10-21T13:00:00Z";
        return null;
      },
      test_automation: () => ({
        matched: false,
        conditions: [
          {
            field: "data.record_kind",
            operator: "eq",
            value: "Task",
            actual: "Build",
            matched: false,
          },
        ],
      }),
      send_automation_notice: () => id(40),
      queue_automation_webhook: () => id(41),
      retry_automation_run: (args) => {
        const row = runs.find((r) => r["id"] === args["p_run_id"]) as Row;
        Object.assign(row, {
          run_status: "Queued",
          error_code: null,
          error_message: null,
          finished_at: null,
          duration_ms: null,
        });
        return args["p_run_id"];
      },
      post_comment: (args) => {
        comments.push(
          tenantRow(id(50), ORG, {
            comment_thread_id: id(51),
            author_person_id: ME,
            body: args["p_body"],
            source: "App",
            edited_at: null,
            deleted_by: null,
          }),
        );
        return id(50);
      },
    },
  );
  return { db, http: requests(contractApp({ handlers: [platform], db })) };
}

describe("Platform: automations", () => {
  it("lists and reads automations with their conditions and actions documents", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get("/automations")),
      "automations.list",
    )) as {
      data: Row[];
    };
    expect(page.data[0]?.["conditions"]).toEqual(CONDITIONS);
    expect(page.data[0]?.["actions"]).toEqual(ACTIONS);
    const one = (await expectContract(
      await success(http.get(`/automations/${AUTO}`)),
      "automations.get",
    )) as Row;
    expect(one["owner_person_id"]).toBe(ME);
    expect((await http.get(`/automations/${id(999)}`)).status).toBe(404);
  });

  it("creates, changes and deletes through app.save_automation and app.delete_automation", async () => {
    const { db, http } = world();
    const createdResponse = await success(
      http.post("/automations", {
        name: "Comment on tasks",
        trigger_event_type: "record.created",
        conditions: { any: [] },
        actions: [{ type: "add_comment", body: "Hello" }],
      }),
    );
    const made = (await expectContract(createdResponse, "automations.create")) as Row;
    expect(made["id"]).toBe(id(5));
    const save = db.calls.find((c) => c.name === "save_automation");
    expect(save?.args).toMatchObject({
      p_org_id: ORG,
      p_automation_id: null,
      p_enabled: false,
      p_description: "",
    });

    const changedResponse = await success(http.patch(`/automations/${AUTO}`, { enabled: false }));
    const changed = (await expectContract(changedResponse, "automations.update")) as Row;
    expect(changed["enabled"]).toBe(false);
    const update = db.calls.filter((c) => c.name === "save_automation")[1];
    expect(update?.args).toMatchObject({
      p_automation_id: AUTO,
      p_name: null,
      p_description: null,
      p_conditions: null,
      p_actions: null,
      p_enabled: false,
      p_expected_updated_at: "2026-10-01T12:00:00.000Z",
    });
    expect(
      (await http.patch(`/automations/${AUTO}`, { name: "Stale" }, 'W/"c3RhbGU"')).status,
    ).toBe(412);

    const removed = await success(http.delete(`/automations/${AUTO}`));
    await expectContract(removed, "automations.delete");
    expect((await http.get(`/automations/${AUTO}`)).status).toBe(404);
  });

  it("answers a refusal of the database as 422 with its rule", async () => {
    const { db, http } = world();
    db.fail(
      "rpc:save_automation",
      refusal("plan_feature_required", "Automations need the Pro plan or above."),
    );
    const refused = await http.post("/automations", {
      name: "Comment on tasks",
      trigger_event_type: "record.created",
      conditions: { all: [] },
      actions: [{ type: "add_comment", body: "Hello" }],
    });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as Row)["rule"]).toBe("plan_feature_required");
    const invalid = await http.post("/automations", {
      name: "Bad",
      trigger_event_type: "record.created",
      conditions: { all: [{ field: "Data.x", operator: "like", value: "1" }] },
      actions: [],
    });
    expect(invalid.status).toBe(422);
    expect(((await invalid.json()) as Row)["type"]).toBe("/problems/validation");
  });

  it("dry-runs the conditions against a sample event", async () => {
    const { http } = world();
    const tested = await success(
      http.post(`/automations/${AUTO}/test`, { event: { data: { record_kind: "Build" } } }),
    );
    const result = (await expectContract(tested, "automations.test")) as Row;
    expect(result["matched"]).toBe(false);
  });
});

describe("Platform: automation runs", () => {
  it("lists and reads runs and their steps", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/automation-runs")), "automationRuns.list");
    await expectContract(await success(http.get(`/automation-runs/${RUN}`)), "automationRuns.get");
    const steps = (await expectContract(
      await success(http.get(`/automation-run-steps?filter[automation_run_id][eq]=${RUN}`)),
      "automationRunSteps.list",
    )) as { data: Row[] };
    expect(steps.data[0]?.["operation_id"]).toBe("comments.postOnSubject");
    await expectContract(
      await success(http.get(`/automation-run-steps/${id(30)}`)),
      "automationRunSteps.get",
    );
  });

  it("notifies and queues a webhook delivery inside a run, and retries a failed run", async () => {
    const { db, http } = world();
    const noticed = await success(
      http.post(`/automation-runs/${RUN}/notices`, { recipient_person_id: ME, title: "New task" }),
    );
    const notice = (await expectContract(noticed, "automationRuns.notify")) as Row;
    expect(notice).toEqual({ notification_id: id(40) });
    expect(db.calls.find((c) => c.name === "send_automation_notice")?.args).toMatchObject({
      p_run_id: RUN,
      p_recipient_person_id: ME,
      p_title: "New task",
      p_body: null,
    });
    const delivered = await success(
      http.post(`/automation-runs/${RUN}/webhook-deliveries`, { webhook_endpoint_id: id(60) }),
    );
    const delivery = (await expectContract(delivered, "automationRuns.deliverWebhook")) as Row;
    expect(delivery).toEqual({ webhook_delivery_id: id(41) });
    const retried = (await expectContract(
      await success(http.post(`/automation-runs/${RUN}/retry`)),
      "automationRuns.retry",
    )) as Row;
    expect(retried["run_status"]).toBe("Queued");
  });
});

describe("Platform: comments by subject", () => {
  it("posts through app.post_comment with the schema-qualified subject table", async () => {
    const { db, http } = world();
    const posted = await success(
      http.post("/comments/on-subject", {
        subject_table: "records",
        subject_id: RECORD,
        body: "Picked up.",
      }),
    );
    const comment = (await expectContract(posted, "comments.postOnSubject")) as Row;
    expect(comment["id"]).toBe(id(50));
    expect(db.calls.find((c) => c.name === "post_comment")?.args).toMatchObject({
      p_subject_table: "app.records",
      p_subject_id: RECORD,
      p_body: "Picked up.",
    });
  });
});

describe("documents from rows", () => {
  it("builds an empty conditions document and every action type", () => {
    expect(conditionsDocument("any", [])).toEqual({ any: [] });
    const row = {
      automation_id: AUTO,
      title_template: null,
      body_template: null,
      project_id: null,
      phase_code: null,
      xyz: null,
      due_in_days: null,
      to_state: null,
      assignee_person_id: null,
      recipient_person_id: null,
      webhook_endpoint_id: null,
    };
    expect(
      actionsDocument([
        { ...row, position: 4, action_type: "call_webhook", webhook_endpoint_id: id(60) },
        {
          ...row,
          position: 1,
          action_type: "create_task",
          title_template: "Call",
          phase_code: "SCP",
          xyz: "Y",
          due_in_days: 2,
        },
        {
          ...row,
          position: 2,
          action_type: "update_status",
          to_state: "Blocked",
          body_template: "Waiting",
        },
        { ...row, position: 3, action_type: "assign", assignee_person_id: ME },
      ]),
    ).toEqual([
      { type: "create_task", title: "Call", phase_code: "SCP", xyz: "Y", due_in_days: 2 },
      { type: "update_status", to_state: "Blocked", note: "Waiting" },
      { type: "assign", assignee_person_id: ME },
      { type: "call_webhook", webhook_endpoint_id: id(60) },
    ]);
  });
});
