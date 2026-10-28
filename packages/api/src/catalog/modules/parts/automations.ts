/**
 * Automations (A91, RRR-136; migrations 1480 and 1481; ADR 0047; finding A65-010): automations with their conditions
 * and actions documents, a dry run against a sample event, the runs ledger and its steps, and the operations the
 * engine's actions call as the automation's owner:
 *   - automationRuns.notify and automationRuns.deliverWebhook, scoped to a running run of the caller's own automation
 *   - comments.postOnSubject, which comments on any commentable row by its table and id, opening its main thread on
 *     first use (app.post_comment): commentThreads.create takes the API's bare table names, which the schema-qualified
 *     app.comment_subjects never matches, so no client could open a thread through the API before
 * catalog/modules/platform.ts spreads these into the Platform additions.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import { AutomationActions, AutomationConditions } from "@xos/schemas/automations";
import type { CapabilityRule } from "../../capabilities.ts";
import { editDefinition, orNull } from "../../correct.ts";
import { collectionAction, itemAction, resource } from "../../define.ts";
import type { ActionSpec, ResourceSpec } from "../../types.ts";
import { Constants } from "@xos/data/database.types";

const label = (values: readonly [string, ...string[]], description: string) =>
  z.enum(values).meta({ description, example: values[0] });

/** Audit people are nullable (ADR 0023): the engine writes runs and pauses with no person. */
const audited = (def: Parameters<typeof editDefinition>[0]) =>
  editDefinition(def, { nullable: ["created_by", "updated_by"] });

const ruleCode = (description: string, example: string) =>
  orNull(
    z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .meta({ description, example }),
  );

const jsonObject = (description: string, example: Record<string, unknown>) =>
  z.record(z.string(), z.unknown()).meta({ description, example });

const EXAMPLE_EVENT = {
  id: fields.EXAMPLE_UUID,
  type: "record.created",
  occurred_at: fields.EXAMPLE_INSTANT,
  project_id: fields.EXAMPLE_UUID,
  subject: { table: "records", id: fields.EXAMPLE_UUID },
  data: { record_kind: "Task", title: "Call the venue" },
};

const ACTION_TYPES = Constants.app.Enums.automation_action_type;

const Automation = editDefinition(
  audited(
    defineResource({
      name: "Automation",
      table: "app.automations",
      description:
        "An automation (Section 7.3, ADR 0047): when a domain event of the trigger type happens in the org and the conditions hold, the actions run in order as the owner through public API operations, so row level security and capabilities decide every write. The owner is whoever last changed what it does or turned it on. Needs the automations plan feature (Pro and above) to create, change or turn on (plan_feature_required: 422); without it an automation can still be turned off and deleted. Saving validates the documents as automation.schema.json does (automation_conditions_invalid, automation_actions_invalid: 422) and checks the actions fit the trigger (automation_action_needs_record, automation_action_needs_commentable_subject, automation_person_not_member, automation_webhook_unknown: 422).",
      serverSet: ["condition_match", "owner_person_id", "paused_at", "pause_reason"],
      fields: {
        name: fields.text("Name shown in Settings, Automations.", "Pick up new tasks", 120),
        description: orNull(
          fields.text("What the automation is for.", "Comments on every new task.", 500),
        ),
        trigger_event_type: z
          .string()
          .regex(/^[a-z][a-z_]*\.[a-z][a-z_]*$/)
          .meta({
            description:
              "Domain event type that starts a run, from the catalog webhooks use (webhookEventTypes.list).",
            example: "record.created",
          }),
        condition_match: label(
          Constants.app.Enums.automation_match,
          "How the top-level conditions combine; set from the conditions document.",
        ),
        owner_person_id: fields.ref("person the actions run as"),
        enabled: fields.bool("True while new events start runs.", true),
        paused_at: orNull(
          fields.instant(
            "When the engine turned the automation off because a run could not act as the owner; null otherwise. Turning it on again clears it.",
          ),
        ),
        pause_reason: ruleCode(
          "Why the engine paused it: owner_left_org, owner_lost_capability, owner_cannot_sign_in or owner_access_refused.",
          "owner_left_org",
        ),
        conditions: AutomationConditions,
        actions: AutomationActions,
      },
    }),
  ),
  { optionalOnCreate: ["enabled"] },
);

const RunStatus = label(
  Constants.app.Enums.automation_run_status,
  "Queued, Running, Retrying after a failure the job queue retries with backoff, Succeeded, Failed, or Skipped (loop_depth, rate_limited, or the automation was off).",
);

const AutomationRun = audited(
  defineResource({
    name: "AutomationRun",
    table: "app.automation_runs",
    description:
      "One run of an automation for one domain event (ADR 0047): an event never runs an automation twice. A run caused by another automation's action is one level deeper; past depth 3 it is Skipped (loop_depth), and past 1,000 runs in an hour in the org new runs are Skipped (rate_limited). A run fails closed when the owner left the org or lost org.automations.write, and the automation pauses with a notice.",
    serverSet: [
      "automation_id",
      "domain_event_id",
      "parent_run_id",
      "depth",
      "run_status",
      "event_payload",
      "owner_person_id",
      "attempts",
      "error_code",
      "error_message",
      "started_at",
      "finished_at",
      "duration_ms",
    ],
    fields: {
      automation_id: fields.ref("automation that ran"),
      domain_event_id: fields.ref("domain event that started the run"),
      parent_run_id: orNull(
        fields.ref("run whose action raised the event, when an automation caused it"),
      ),
      depth: fields.int("Automation runs that led to this one; 0 for an event a person raised.", 0),
      run_status: RunStatus,
      event_payload: jsonObject("The event as webhooks send it: the run's input.", EXAMPLE_EVENT),
      owner_person_id: orNull(fields.ref("person the run acted as")),
      attempts: fields.int("Times the worker started the run.", 1),
      error_code: ruleCode("Rule code of the failure or skip.", "owner_left_org"),
      error_message: orNull(
        fields.text("Why the run failed or was skipped.", "The API answered 503.", 2000),
      ),
      started_at: orNull(fields.instant("When the worker first started the run.")),
      finished_at: orNull(fields.instant("When the run reached Succeeded, Failed or Skipped.")),
      duration_ms: orNull(fields.int("Milliseconds from the first start to the end.", 840)),
    },
  }),
);

const AutomationRunStep = audited(
  defineResource({
    name: "AutomationRunStep",
    table: "app.automation_run_steps",
    description:
      "One action of an automation run: the public API operation called as the owner, what was sent and answered, and how long it took. A retried run rewrites the step of the action that failed.",
    serverSet: [
      "automation_run_id",
      "automation_action_id",
      "position",
      "action_type",
      "operation_id",
      "step_status",
      "request_body",
      "response_body",
      "http_status",
      "error_code",
      "error_message",
      "started_at",
      "finished_at",
      "duration_ms",
    ],
    fields: {
      automation_run_id: fields.ref("run the step belongs to"),
      automation_action_id: orNull(fields.ref("action the step ran")),
      position: fields.int("Position of the action, 1 first.", 1, 1),
      action_type: label(ACTION_TYPES, "What the action does."),
      operation_id: orNull(fields.code("Public API operation called.", "records.create")),
      step_status: label(Constants.app.Enums.automation_step_status, "Outcome of the action."),
      request_body: orNull(
        jsonObject("Body sent, with templates filled in from the event.", {
          title: "Review Call the venue",
        }),
      ),
      response_body: orNull(
        jsonObject("Identifying fields of the answer, or the problem it reported.", {
          id: fields.EXAMPLE_UUID,
        }),
      ),
      http_status: orNull(fields.int("HTTP status the API answered.", 201, 100)),
      error_code: ruleCode("Rule code of the failure.", "record_title_grammar"),
      error_message: orNull(
        fields.text("Why the step failed.", "A Task title starts with an imperative verb.", 2000),
      ),
      started_at: fields.instant("When the step started."),
      finished_at: fields.instant("When the step ended."),
      duration_ms: fields.int("Milliseconds the step took.", 120),
    },
  }),
);

const TestRequest = z
  .object({
    event: jsonObject(
      "A sample event body, as a webhook receives it; app.sample_automation_event gives the org's latest of the trigger type.",
      EXAMPLE_EVENT,
    ),
  })
  .meta({
    id: "AutomationTestRequest",
    description: "A sample event to test an automation against.",
  });

const TestResult = z
  .object({
    matched: fields.bool("Whether the conditions hold for the sample event.", true),
    conditions: z
      .array(
        z
          .object({
            field: fields.text("Path into the event.", "data.record_kind"),
            operator: label(Constants.app.Enums.filter_operator, "Filter operator."),
            value: orNull(fields.text("Value compared.", "Task", 1000)),
            actual: z.unknown().meta({
              description: "Value found in the event; null when missing.",
              example: "Task",
            }),
            matched: fields.bool("Whether the condition held.", true),
          })
          .meta({ id: "AutomationConditionResult", description: "One condition of a dry run." }),
      )
      .meta({ description: "Each condition in document order.", example: [] }),
  })
  .meta({
    id: "AutomationTestResult",
    description: "A dry run of an automation's conditions: nothing runs and nothing is written.",
  });

const NoticeRequest = z
  .object({
    recipient_person_id: fields.ref("member who receives the notification"),
    title: fields.text("Notification title.", "New task: Call the venue", 200),
    body: fields
      .longText("Message; the title is repeated when absent.", "Call the venue needs a look.")
      .max(2000)
      .optional(),
  })
  .meta({
    id: "AutomationNoticeRequest",
    description: "A notification an automation sends during a run.",
  });

const NoticeResult = z
  .object({
    notification_id: orNull(fields.ref("notification created")),
  })
  .meta({ id: "AutomationNoticeResult", description: "The notification an automation sent." });

const WebhookRequest = z
  .object({ webhook_endpoint_id: fields.ref("the org's webhook endpoint") })
  .meta({
    id: "AutomationWebhookRequest",
    description: "The endpoint a run's event is delivered to.",
  });

const WebhookResult = z
  .object({ webhook_delivery_id: fields.ref("webhook delivery queued") })
  .meta({ id: "AutomationWebhookResult", description: "The delivery a run queued." });

const SubjectCommentRequest = z
  .object({
    subject_table: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .meta({
        description: "Table of the subject, one of app.comment_subjects without its schema.",
        example: "records",
      }),
    subject_id: fields.ref("row commented on"),
    body: fields.longText("Comment text.", "Picked up, thanks.").max(20000),
    anchor: fields
      .text("Part of the subject the thread is anchored to; absent for the main thread.", "line:12")
      .optional(),
  })
  .meta({
    id: "SubjectCommentRequest",
    description:
      "A comment on a subject row, posted in its main thread or the thread of an anchor.",
  });

export const automationResources: readonly ResourceSpec[] = [
  resource("Platform", "/automations", Automation, {
    order: { by: ["name"], numeric: false },
    actions: [
      itemAction("test", {
        summary: "Test an automation against a sample event",
        description:
          "Dry run of the automation's conditions against a sample event body through `app.test_automation`: whether they match and, per condition, the value found. Nothing runs and nothing is written. Needs org.automations.write.",
        body: TestRequest,
        response: TestResult,
        rpc: "test_automation",
      }),
    ],
  }),
  resource("Platform", "/automation-runs", AutomationRun, {
    verbs: ["list", "get"],
    order: { by: ["created_at"], numeric: false, descending: true },
    actions: [
      itemAction("notify", {
        segment: "notices",
        summary: "Notify a member from a running automation run",
        description:
          "The notify action (ADR 0047): during a run, the automation's owner notifies a member of the org (automation.notice) about the event's subject, through `app.send_automation_notice`. Only a running run of the caller's own automation (404 otherwise); the recipient must be a member (automation_person_not_member: 422). Needs org.automations.write.",
        body: NoticeRequest,
        response: NoticeResult,
        status: 201,
        rpc: "send_automation_notice",
      }),
      itemAction("deliverWebhook", {
        segment: "webhook-deliveries",
        summary: "Send a running run's event to a webhook endpoint",
        description:
          "The call_webhook action (ADR 0047): during a run, its owner queues a delivery of the run's event to one of the org's webhook endpoints through `app.queue_automation_webhook`; the webhook dispatcher signs and retries it like every webhook. Needs org.automations.write, org.webhooks.manage and the webhooks plan feature.",
        body: WebhookRequest,
        response: WebhookResult,
        status: 201,
        rpc: "queue_automation_webhook",
      }),
      itemAction("retry", {
        summary: "Retry a failed automation run",
        description:
          "Queues a failed run again through `app.retry_automation_run`; steps that succeeded are not run again. The automation must be on (automation_off: 422) and the run Failed (automation_run_not_failed: 422). Needs org.automations.write.",
        rpc: "retry_automation_run",
      }),
    ],
  }),
  resource("Platform", "/automation-run-steps", AutomationRunStep, {
    verbs: ["list", "get"],
    order: { by: ["automation_run_id", "position"], numeric: false },
  }),
];

export const automationActions: Readonly<Record<string, readonly ActionSpec[]>> = {
  comments: [
    collectionAction("postOnSubject", {
      segment: "on-subject",
      summary: "Comment on a subject",
      description:
        "Posts a comment on any row of app.comment_subjects by its table and id, as the caller, in the subject's main thread or the thread of an anchor, opening the thread on first use (`app.post_comment`). The subject's own read policy decides (404 when it is not visible). The add_comment action of automations calls it as the automation's owner.",
      body: SubjectCommentRequest,
      status: 201,
      rpc: "post_comment",
    }),
  ],
};

export const automationCapabilities: Readonly<Record<string, CapabilityRule>> = {
  automations: {
    read: "org.automations.write",
    write: "org.automations.write",
    actions: { test: "org.automations.write" },
  },
  automationRuns: {
    read: "org.automations.write",
    actions: {
      notify: "org.automations.write",
      deliverWebhook: "org.automations.write",
      retry: "org.automations.write",
    },
  },
  automationRunSteps: { read: "org.automations.write" },
  comments: { actions: { postOnSubject: "work.record.write" } },
};
