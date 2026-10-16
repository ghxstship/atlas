/**
 * Platform workflow (A33, migrations 1030 to 1034): approvals, Trash, templates and org state labels.
 * The frozen v1 shapes of `approvalPolicies`, `approvalInstances`, `approvalDecisions`, `trashItems`,
 * `templates` and `templateApplications` are corrected to the schema (ADR 0023); approval steps,
 * template versions and template items are added resources, and the lifecycle RPCs are added
 * actions. catalog/modules/platform.ts spreads them into the Platform additions.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { all, editDefinition, editShape, orNull } from "../../correct.ts";
import type { CorrectionInput } from "../../corrections.ts";
import { collectionAction, itemAction, resource, transitionBody } from "../../define.ts";
import type { ActionSpec, ResourceSpec } from "../../types.ts";

const SINCE = "1.0.0-draft.2";

const label = (values: readonly [string, ...string[]], description: string) =>
  z.enum(values).meta({ description, example: values[0] });

const optional = (schema: z.ZodType) => ({ schema, create: "optional" as const });
const required = (schema: z.ZodType) => ({ schema, create: "required" as const, update: false });
const writeOnly = (schema: z.ZodType, create: "required" | "optional") => ({
  schema,
  create,
  update: false,
  read: false as const,
});

/** Audit people are nullable on every resource (ADR 0023): seed and platform rows carry none. */
const audited = (def: Parameters<typeof editDefinition>[0]) =>
  editDefinition(def, { nullable: ["created_by", "updated_by"] });

/** Spend document types an approval policy gates (app.approval_policies, 1030). */
export const APPROVAL_DOCUMENT_TYPES = [
  "Purchase Order",
  "Change Order",
  "Expense",
  "Invoice Approval",
  "Payroll Run",
  "Requisition",
] as const;

const PolicyState = z.enum(["Draft", "Active", "Retired"]);
const ApprovalState = z.enum(["In Review", "Approved", "Rejected", "Canceled"]);
const ScopeKind = z.enum(["Standing Venue", "Show"]);

const documentType = (description: string) => label(APPROVAL_DOCUMENT_TYPES, description);

// Added resources -------------------------------------------------------------------------------------

const ApprovalStep = audited(
  defineResource({
    name: "ApprovalStep",
    table: "app.approval_steps",
    description:
      "An ordered step of an approval policy (1030). It names its approvers: everyone holding a role, or one member. Steps change only while the policy is a Draft (approval_step_policy_not_draft: 422).",
    fields: {
      approval_policy_id: fields.ref("approval policy"),
      step_order: fields.int("Position of the step, 1 first; steps are decided in order.", 1, 1),
      name: fields.text("Step name.", "Department head", 200),
      approver_role_id: fields.ref("role whose holders decide the step").nullable(),
      approver_membership_id: fields.ref("the one member who decides the step").nullable(),
    },
    immutable: ["approval_policy_id"],
  }),
);

const TemplateVersion = audited(
  defineResource({
    name: "TemplateVersion",
    table: "app.template_versions",
    description:
      "A version of a template (1032): the project defaults and ordered items. Edited while a draft; publishing (templateVersions.publish) freezes it and makes it the template's current version.",
    fields: {
      template_id: fields.ref("template"),
      version_number: fields.int("Version number, issued in order, 1 first.", 1, 1),
      notes: fields
        .longText("What changed in this version.", "Adds the load-out records.")
        .nullable(),
      default_time_zone: fields.timeZone("IANA time zone a new project starts with.").nullable(),
      default_tier_code: fields.code("Canon tier a new project starts with.", "05").nullable(),
      default_region_code: fields.code("Canon region a new project starts with.", "SE").nullable(),
      default_jurisdiction_id: fields
        .code("Canon jurisdiction a new project starts with.", "US-FL-MIAMI-DADE")
        .nullable(),
      default_currency_code: fields
        .currency("ISO 4217 currency a new project starts with.")
        .nullable(),
      duration_days: fields.int("Length of the project in days.", 3, 1).nullable(),
      published_at: fields
        .instant("When the version was published; null while a draft.")
        .nullable(),
    },
    serverSet: ["version_number", "published_at"],
    immutable: ["template_id"],
  }),
);

const TemplateItem = audited(
  defineResource({
    name: "TemplateItem",
    table: "app.template_items",
    description:
      "An item of a template version (1032): a scope node created under the new project's engagement root ({KEY}-{suffix}), or a record due a number of days after the project start. Items of a published version are frozen (template_version_published: 422).",
    fields: {
      template_version_id: fields.ref("template version"),
      item_kind: label(["Scope Node", "Record"], "What the item creates."),
      sort_order: fields.int("Position in the version, 1 first.", 1, 1),
      name: fields.text("Scope node name, or record title.", "Opening Night", 200),
      scope_kind: ScopeKind.nullable().meta({
        description: "For a scope node: Show or Standing Venue.",
        example: "Show",
      }),
      scope_code_suffix: fields
        .code("For a scope node: code after the project key.", "E02")
        .nullable(),
      record_kind: fields.text("For a record: canon record kind.", "Inspection", 50).nullable(),
      xyz: label(["X", "Y", "Z"], "For a record: declared schema family tag.").nullable(),
      phase_code: fields.code("For a record: canon phase.", "SCP").nullable(),
      due_offset_days: z.int().min(-3660).max(3660).nullable().meta({
        description: "For a record: due this many days after the project start; null for none.",
        example: 3,
      }),
    },
    immutable: ["template_version_id", "item_kind"],
  }),
);

const TrashRestoreResult = z
  .object({
    subject_urn: z.string().meta({
      description: "URN of the restored row.",
      example: "urn:xpms:budgets:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    }),
    subject_table: z
      .string()
      .meta({ description: "Table of the restored row.", example: "budgets" }),
    subject_id: fields.ref("restored row"),
    rows_restored: fields.int(
      "Rows restored: the row and the rows that reference it and were deleted with it.",
      2,
      1,
    ),
  })
  .meta({ id: "TrashRestoreResult", description: "What a restore from Trash brought back." });

const reasonBody = (id: string, what: string) =>
  z
    .object({
      reason: z
        .string()
        .min(1)
        .max(500)
        .meta({ description: `Why ${what}.`, example: "Submitted against the wrong order." }),
    })
    .meta({ id, description: `Request to ${what}.` });

export const workflowResources: readonly ResourceSpec[] = [
  resource("Platform", "/approval-steps", ApprovalStep, {
    order: { by: ["approval_policy_id", "step_order"], numeric: false },
  }),
  resource("Platform", "/template-versions", TemplateVersion, {
    verbs: ["list", "get", "create", "update", "delete"],
    order: { by: ["template_id", "version_number"], numeric: false },
    actions: [
      itemAction("publish", {
        summary: "Publish a template version",
        description:
          "Publishes a draft version (app.publish_template_version, projects.template.write): freezes it and makes it the template's current version. A published version answers 422 (template_version_published).",
        rpc: "publish_template_version",
      }),
    ],
  }),
  resource("Platform", "/template-items", TemplateItem, {
    order: { by: ["template_version_id", "sort_order"], numeric: false },
  }),
];

export const workflowActions: Readonly<Record<string, readonly ActionSpec[]>> = {
  approvalPolicies: [
    itemAction("transition", {
      segment: "transitions",
      summary: "Activate or retire an approval policy",
      description:
        "Moves a policy Draft to Active, Draft to Retired or Active to Retired with compare-and-set (app.transition_approval_policy). Activation needs a step (approval_policy_no_steps) and no other Active policy of the document type (approval_policy_active_exists).",
      body: transitionBody("ApprovalPolicyTransitionRequest", PolicyState, ["Draft", "Active"]),
      rpc: "transition_approval_policy",
    }),
  ],
  approvalInstances: [
    itemAction("cancel", {
      summary: "Withdraw an approval",
      description:
        "Withdraws an approval in review, or an Approved one the document has not used (app.cancel_approval): the requester, when approvals.requester_may_cancel allows it (approval_requester_cancel_off: 422), or a holder of org.approval_policies.write.",
      body: reasonBody("ApprovalCancelRequest", "the approval is withdrawn"),
      rpc: "cancel_approval",
    }),
  ],
  templates: [
    collectionAction("createFromProject", {
      segment: "from-project",
      summary: "Save a project as a template",
      description:
        "Creates a template from a project as the caller (app.create_template_from_project): its defaults, show and standing venue scope nodes and open records become a published first version. Needs projects.template.write.",
      body: z
        .object({
          project_id: fields.ref("project saved as a template"),
          name: fields.text("Template name.", "Three-Day Festival", 200),
          description: fields
            .longText("When to use the template.", "Outdoor weekend shows.")
            .optional(),
        })
        .meta({
          id: "TemplateFromProjectRequest",
          description: "A project to save as a template.",
        }),
      status: 201,
      rpc: "create_template_from_project",
    }),
  ],
};

export const workflowCapabilities: Readonly<Record<string, CapabilityRule>> = {
  approvalSteps: { read: "org.settings.read", write: "org.approval_policies.write" },
  templateVersions: {
    read: "projects.project.read",
    write: "projects.template.write",
    actions: { publish: "projects.template.write" },
  },
  templateItems: { read: "projects.project.read", write: "projects.template.write" },
  approvalPolicies: { actions: { transition: "org.approval_policies.write" } },
  approvalInstances: { actions: { cancel: "inbox.notifications.write" } },
  templates: { actions: { createFromProject: "projects.template.write" } },
};

// Corrections -----------------------------------------------------------------------------------------

export const workflowCorrections: readonly CorrectionInput[] = [
  {
    id: "approval-policy-gating",
    since: SINCE,
    resources: ["approvalPolicies"],
    components: ["schemas/SpendDocumentType"],
    change:
      "`document_type` takes the six gated spend document types, gaining Requisition and leaving out Contract (SpendDocumentType, referenced by no other operation once spend authority was corrected, leaves the document); adds `description`, the optional threshold `applies_above_minor` with its `currency_code`, and the server-set `policy_state` (Draft, Active or Retired).",
    reason:
      "app.approval_policies (1030) is keyed by app.spend_document_type, which has included Requisition since 0360; settlement rounds (Contract) are approved per round and are not gated by policies (approval_policies_document_type_supported). A policy may apply only above an amount in one currency and moves through its own lifecycle (app.transition_approval_policy).",
    apply: editShape({
      add: {
        document_type: required(documentType("Spend document type the policy gates.")),
        description: optional(
          orNull(
            fields.longText("What the policy is for.", "Every purchase order goes to finance."),
          ),
        ),
        currency_code: optional(
          orNull(
            fields.currency("ISO 4217 currency of applies_above_minor; null for every amount."),
          ),
        ),
        applies_above_minor: optional(
          fields.money(
            "The policy applies above this amount in currency_code, and to every amount in another currency; null for every document of the type.",
            1000000,
          ),
        ),
        policy_state: {
          schema: PolicyState.meta({ description: "Policy state.", example: "Active" }),
        },
      },
    }),
  },
  {
    id: "approval-instance-document",
    since: SINCE,
    resources: ["approvalInstances"],
    change:
      "`subject_urn` gives way to `document_type` and `document_id` (required on create); `approval_policy_id` becomes server-set (the Active policy that applies); adds the server-set `subject_table`, `subject_reference`, `project_id`, `amount_minor` with `currency_code`, `current_step` and `decided_at`; `approval_state` is In Review, Approved, Rejected or Canceled.",
    reason:
      "app.approval_instances (1030) is created only by app.request_approval, which takes the document type and id, finds the Active policy that applies and reads the amount, currency and project from the document itself, so a requester cannot submit a smaller amount than the document carries.",
    apply: editShape({
      remove: ["subject_urn"],
      serverSet: ["approval_policy_id"],
      add: {
        document_type: required(documentType("Spend document type.")),
        document_id: required(fields.ref("spend document submitted for approval")),
        subject_table: {
          schema: fields.code("Table of the document.", "purchase_orders"),
        },
        subject_reference: {
          schema: orNull(fields.text("The document's own number or name.", "17")),
        },
        project_id: { schema: orNull(fields.ref("project of the document")) },
        amount_minor: {
          schema: fields.money(
            "Amount submitted; the approval covers the document while its amount stays at or below it. Never null: an unpriced document is not submitted.",
            4000000,
          ),
        },
        currency_code: { schema: fields.currency("ISO 4217 currency of the amount.") },
        current_step: {
          schema: fields.int("Step the approval waits on; the last step once decided.", 1, 1),
        },
        decided_at: {
          schema: orNull(fields.instant("When it was approved, rejected or canceled.")),
        },
        approval_state: {
          schema: ApprovalState.meta({ description: "Approval state.", example: "In Review" }),
        },
      },
    }),
  },
  {
    id: "approval-decision-step",
    since: SINCE,
    resources: ["approvalDecisions"],
    change: "Adds the server-set `step_order` of the step decided.",
    reason:
      "app.approval_decisions (1030) records which step each decision decided (one per step, one step per approver); app.decide_approval decides the step the approval waits on.",
    apply: editShape({
      add: { step_order: { schema: fields.int("Step decided.", 1, 1) } },
    }),
  },
  {
    id: "trash-item-subject",
    since: SINCE,
    resources: ["trashItems"],
    components: ["schemas/TrashRestoreResult"],
    change:
      "Adds `subject_table`, `subject_id`, `org_id`, `project_id`, `title` and `deleted_by`; `trashItems.restore` answers TrashRestoreResult (the URN, table, id and rows restored) instead of the TrashItem, which leaves Trash when restored.",
    reason:
      "app.trash_items (1031) is a view over the soft-deleted rows of the Trash tables, naming each row's table, id, org, project and title and who deleted it; app.restore_trash_item restores the row and the rows deleted with it, after which the row is no longer a Trash item.",
    apply: all(
      editShape({
        add: {
          subject_table: { schema: fields.code("Table of the deleted row.", "budgets") },
          subject_id: { schema: fields.ref("deleted row") },
          org_id: { schema: fields.ref("org of the deleted row") },
          project_id: { schema: orNull(fields.ref("project of the deleted row")) },
          title: { schema: orNull(fields.text("What the row is called.", "Summer Series Budget")) },
          deleted_by: { schema: orNull(fields.ref("person who deleted it")) },
        },
      }),
      (spec: ResourceSpec): ResourceSpec => ({
        ...spec,
        actions: spec.actions.map((a) =>
          a.verb !== "restore"
            ? a
            : {
                ...a,
                description:
                  "Restores a soft-deleted row within its retention period, as the caller (app.restore_trash_item): the table's own update rules decide. Rows that reference it and were deleted with it come back too. A row past retention answers 422 (trash_restore_expired), a live row 422 (trash_not_deleted).",
                response: TrashRestoreResult,
                rpc: "restore_trash_item",
              },
        ),
      }),
    ),
  },
  {
    id: "template-description-kind",
    since: SINCE,
    resources: ["templates"],
    change: "Adds `description` and `template_kind` (Project).",
    reason:
      "app.templates (1032) describes when to use a template and records what it creates (app.template_kind, Project).",
    apply: editShape({
      add: {
        description: optional(
          orNull(fields.longText("When to use the template.", "Outdoor weekend shows.")),
        ),
        template_kind: optional(label(["Project"], "What the template creates.")),
      },
    }),
  },
  {
    id: "template-application-project-input",
    since: SINCE,
    resources: ["templateApplications"],
    change:
      "TemplateApplicationCreate takes the write-only `project_key` and `name` (required), `time_zone`, `starts_on` and `venue_id` of the project to create; the read shape adds the server-set `template_version_id`, `scope_nodes_created` and `records_created`.",
    reason:
      "app.apply_template (1032) creates the project through app.create_project, which needs a key, a name and a time zone (the version's default when omitted), dates its records from the start date, and records the published version used and what it created in app.template_applications.",
    apply: editShape({
      add: {
        project_key: writeOnly(fields.code("Key of the project to create.", "NWT"), "required"),
        name: writeOnly(
          fields.text("Name of the project to create.", "Tidewater Weekend", 200),
          "required",
        ),
        time_zone: writeOnly(
          fields.timeZone("IANA time zone; defaults to the version's."),
          "optional",
        ),
        starts_on: writeOnly(
          fields.date("Start date; records are due relative to it."),
          "optional",
        ),
        venue_id: writeOnly(fields.ref("venue of the project and its shows"), "optional"),
        template_version_id: { schema: fields.ref("published version applied") },
        scope_nodes_created: { schema: fields.int("Scope nodes created.", 1) },
        records_created: { schema: fields.int("Records created.", 4) },
      },
    }),
  },
];
