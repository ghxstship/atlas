/**
 * Automations (A91, ADR 0047, finding A65-010): the JSON document form of an automation's conditions and actions.
 * The API, Atlas and the worker exchange these documents; the database stores them as rows (migration 1480,
 * app.automation_conditions and app.automation_actions) and validates them with its SQL twins,
 * private.automation_conditions_refusal and private.automation_actions_refusal. `automation.schema.json` beside
 * this package's package.json is the JSON Schema rendering of these Zod schemas (generate:automations).
 *
 * Both validators run the shared vectors in ./vectors.json, so a document one accepts the other accepts. JSON Schema
 * cannot say everything the Zod schema checks (the total of 20 conditions and groups, a title that is not only
 * spaces); the refinements carry those, and the database checks them again.
 */
import { z } from "zod";
import { RecordState } from "../common/enums.ts";

/** The API filter operators (ADR 0003), the same set as app.filter_operator. */
// eslint-disable-next-line xos/no-restated-enums -- below @xos/data; test/database-enums.test.ts holds it equal
export const FILTER_OPERATORS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "is_null",
  "contains",
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/** What an action does (app.automation_action_type), each through a public API operation run as the owner. */
// eslint-disable-next-line xos/no-restated-enums -- below @xos/data; test/database-enums.test.ts holds it equal
export const AUTOMATION_ACTION_TYPES = [
  "create_task",
  "update_status",
  "assign",
  "add_comment",
  "notify",
  "call_webhook",
] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

/** The public API operation each action calls (ADR 0047). */
export const ACTION_OPERATIONS: Readonly<Record<AutomationActionType, string>> = {
  create_task: "records.create",
  update_status: "records.transition",
  assign: "records.update",
  add_comment: "comments.postOnSubject",
  notify: "automationRuns.notify",
  call_webhook: "automationRuns.deliverWebhook",
};

/** Limits shared with the database (1480, 1481). */
export const AUTOMATION_LIMITS = {
  conditions: 20,
  actions: 10,
  name: 120,
  description: 500,
  title: 200,
  body: 2000,
  value: 1000,
  dueInDays: 365,
  pathSegments: 8,
  /** private.automation_max_depth(): runs deeper in an automation-caused chain are Skipped (loop_depth). */
  maxDepth: 3,
  /** private.automation_hourly_run_limit(): runs an org may start in an hour. */
  runsPerHour: 1000,
} as const;

/** A path into the event body: lower-case segments joined by dots, at most eight. */
export const FIELD_PATH = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,7}$/;
/** An id as the database writes it. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An event type of the catalog (private.domain_event_types). */
export const EVENT_TYPE = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;

/** Trims spaces only, as Postgres btrim does by default. */
export function trimSpaces(text: string): string {
  return text.replace(/^ +| +$/g, "");
}

/** Length in code points, as Postgres char_length counts. */
export function codePoints(text: string): number {
  return Array.from(text).length;
}

const field = z.string().regex(FIELD_PATH).meta({
  description: "Path into the event, such as data.record_kind.",
  example: "data.record_kind",
});

const valueText = z
  .string()
  .max(AUTOMATION_LIMITS.value)
  .refine((v) => codePoints(v) <= AUTOMATION_LIMITS.value, {
    message: "At most 1,000 characters.",
  });

const isNullValue = z
  .enum(["true", "false"])
  .meta({ description: "true (or absent) holds for a missing value, false for a present one." })
  .nullable()
  .optional();

const IsNullCondition = z
  .object({
    field,
    operator: z.literal("is_null"),
    value: isNullValue,
  })
  .strict();

const InCondition = z
  .object({
    field,
    operator: z.literal("in"),
    value: valueText
      .regex(/[^, ]/, { message: "List at least one value, separated by commas." })
      .meta({ description: "Comma-separated values, each trimmed.", example: "Build, Task" }),
  })
  .strict();

const ValueCondition = z
  .object({
    field,
    operator: z.enum(["eq", "ne", "lt", "lte", "gt", "gte", "contains"]),
    value: valueText.meta({ description: "Value compared, as text.", example: "Task" }),
  })
  .strict();

export const AutomationCondition = z.union([ValueCondition, InCondition, IsNullCondition]).meta({
  id: "AutomationCondition",
  description:
    "One condition: a path of the event, an API filter operator (ADR 0003) and a text value. Numbers compare numerically, strings by code point; contains folds ASCII case or finds an array element; every operator but is_null is false on a missing value.",
});
export type AutomationCondition = z.infer<typeof AutomationCondition>;

const conditionList = z.array(AutomationCondition).min(1).max(AUTOMATION_LIMITS.conditions);

export const AutomationConditionGroup = z
  .union([z.object({ all: conditionList }).strict(), z.object({ any: conditionList }).strict()])
  .meta({
    id: "AutomationConditionGroup",
    description: "A group of conditions that all, or any one, must hold. Groups nest one level.",
  });
export type AutomationConditionGroup = z.infer<typeof AutomationConditionGroup>;

const item = z.union([AutomationCondition, AutomationConditionGroup]);
const itemList = z.array(item).max(AUTOMATION_LIMITS.conditions);
export type AutomationConditionItem = z.infer<typeof item>;

/** Conditions and groups in a document, counted as the database counts them. */
export function countConditions(items: readonly AutomationConditionItem[]): number {
  return items.reduce((total, entry) => {
    if ("all" in entry) return total + 1 + entry.all.length;
    if ("any" in entry) return total + 1 + entry.any.length;
    return total + 1;
  }, 0);
}

const withinTotal = (items: readonly AutomationConditionItem[]) =>
  countConditions(items) <= AUTOMATION_LIMITS.conditions;
const totalMessage = { message: "An automation has at most 20 conditions and groups." };

export const AutomationConditions = z
  .union([
    z.object({ all: itemList.refine(withinTotal, totalMessage) }).strict(),
    z.object({ any: itemList.refine(withinTotal, totalMessage) }).strict(),
  ])
  .meta({
    id: "AutomationConditions",
    description:
      'An automation\'s conditions: {"all": [...]} or {"any": [...]} of conditions and one-level groups, at most 20 in all. An empty list always holds.',
    example: { all: [{ field: "data.record_kind", operator: "eq", value: "Task" }] },
  });
export type AutomationConditions = z.infer<typeof AutomationConditions>;

const title = z
  .string()
  .min(1)
  .max(AUTOMATION_LIMITS.title)
  .refine((t) => {
    const n = codePoints(trimSpaces(t));
    return n >= 1 && n <= AUTOMATION_LIMITS.title;
  }, "1 to 200 characters.")
  .meta({
    description: "Text; event paths in double braces are filled in, such as {{data.title}}.",
    example: "Review {{data.title}}",
  });

const body = z
  .string()
  .min(1)
  .max(AUTOMATION_LIMITS.body)
  .refine((t) => {
    const n = codePoints(trimSpaces(t));
    return n >= 1 && n <= AUTOMATION_LIMITS.body;
  }, "1 to 2,000 characters.")
  .meta({
    description: "Text; event paths in double braces are filled in, such as {{data.title}}.",
    example: "Picked up {{data.title}}.",
  });

const id = (description: string) =>
  z.string().regex(UUID).meta({ description, example: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f" });

const CreateTask = z
  .object({
    type: z.literal("create_task"),
    title,
    project_id: id(
      "Project the Task goes in, under its engagement root; null for the event's project.",
    )
      .nullable()
      .optional(),
    phase_code: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .meta({ description: "Gated phase of the Task.", example: "SCP" }),
    xyz: z
      .enum(["X", "Y", "Z"])
      .meta({ description: "Declared XYZ tag of the Task.", example: "Y" }),
    due_in_days: z.int().min(0).max(AUTOMATION_LIMITS.dueInDays).nullable().optional().meta({
      description: "Due at 17:00 on the org's calendar this many days after the run.",
      example: 2,
    }),
  })
  .strict();

const STATES_WITH_NOTES = ["Blocked", "Deferred"] as const;
const PLAIN_STATES = RecordState.options.filter(
  (s) => !(STATES_WITH_NOTES as readonly string[]).includes(s),
) as [string, ...string[]];

const UpdateStatus = z.union([
  z
    .object({
      type: z.literal("update_status"),
      to_state: z
        .enum(PLAIN_STATES)
        .meta({ description: "Record state the subject record moves to." }),
      note: body.nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("update_status"),
      to_state: z.enum(STATES_WITH_NOTES),
      note: body.meta({ description: "The blocker (Blocked) or the replan reason (Deferred)." }),
    })
    .strict(),
]);

const Assign = z
  .object({
    type: z.literal("assign"),
    assignee_person_id: id("Member who becomes the subject record's owner."),
  })
  .strict();

const AddComment = z.object({ type: z.literal("add_comment"), body }).strict();

const Notify = z
  .object({
    type: z.literal("notify"),
    recipient_person_id: id("Member who receives the notification."),
    title,
    body: body.nullable().optional(),
  })
  .strict();

const CallWebhook = z
  .object({
    type: z.literal("call_webhook"),
    webhook_endpoint_id: id("The org's webhook endpoint."),
  })
  .strict();

export const AutomationAction = z
  .union([CreateTask, UpdateStatus, Assign, AddComment, Notify, CallWebhook])
  .meta({
    id: "AutomationAction",
    description:
      "One action, run in order as the owner through a public API operation: create_task (records.create), update_status (records.transition), assign (records.update), add_comment (comments.postOnSubject), notify (automationRuns.notify) or call_webhook (automationRuns.deliverWebhook).",
  });
export type AutomationAction = z.infer<typeof AutomationAction>;

export const AutomationActions = z
  .array(AutomationAction)
  .min(1)
  .max(AUTOMATION_LIMITS.actions)
  .meta({
    id: "AutomationActions",
    description: "An automation's 1 to 10 actions, in the order they run.",
    example: [{ type: "add_comment", body: "Picked up {{data.title}}." }],
  });
export type AutomationActions = z.infer<typeof AutomationActions>;

/** The whole definition app.save_automation takes, as the JSON Schema document describes it. */
export const AutomationDefinition = z
  .object({
    name: z
      .string()
      .min(1)
      .max(AUTOMATION_LIMITS.name)
      .meta({ description: "Name shown in Settings, Automations.", example: "Pick up new tasks" }),
    description: z.string().max(AUTOMATION_LIMITS.description).nullable().optional(),
    trigger_event_type: z.string().regex(EVENT_TYPE).meta({
      description: "Domain event type from the catalog (GET /webhook-events).",
      example: "record.created",
    }),
    conditions: AutomationConditions,
    actions: AutomationActions,
    enabled: z.boolean().optional(),
  })
  .strict()
  .meta({
    id: "AutomationDefinition",
    description: "An automation: its trigger, conditions and actions.",
  });
export type AutomationDefinition = z.infer<typeof AutomationDefinition>;

/** The JSON Schema document of an automation definition (draft 2020-12), as `automation.schema.json` holds it. */
export function automationJsonSchema(): Record<string, unknown> {
  return {
    title: "XOS automation",
    ...z.toJSONSchema(AutomationDefinition, { target: "draft-2020-12", unrepresentable: "any" }),
  };
}
