/**
 * Platform operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on Platform resources here. See "Adding operations" in
 * packages/api/README.md. Corrections to frozen Platform resources follow ADR 0023.
 */
import { z } from "@hono/zod-openapi";
import { Classification, fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { all, editShape, orNull, putActions, removeVerbs } from "../correct.ts";
import { collectionAction } from "../define.ts";
import type { ResourceSpec } from "../types.ts";
import {
  viewsHelpSupportCapabilities,
  viewsHelpSupportResources,
} from "./parts/views-help-support.ts";
import { a36Actions, a36Capabilities, a36Corrections, a36Resources } from "./parts/a36.ts";
import { a84Actions, a84Capabilities, a84Resources, CalendarFeedToken } from "./parts/a84.ts";
import {
  workflowActions,
  workflowCapabilities,
  workflowCorrections,
  workflowResources,
} from "./parts/workflow.ts";

const label = (values: readonly [string, ...string[]], description: string) =>
  z.enum(values).meta({ description, example: values[0] });

const optional = (schema: z.ZodType) => ({ schema, create: "optional" as const });

const tableName = (description: string) =>
  z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .meta({ description, example: "records" });

/** The create verb as a collection action at the same path, answering `response` with 201. */
const createAnswering =
  (response: z.ZodType, rpc: string, summary: string, description: string) =>
  (spec: ResourceSpec): ResourceSpec => {
    const body = spec.def.create;
    if (body === undefined) throw new Error(`${spec.op} has no create body.`);
    return putActions([
      collectionAction("create", {
        segment: "",
        summary,
        description,
        body,
        response,
        rpc,
        status: 201,
      }),
    ])(removeVerbs("create")(spec));
  };

export const additions = defineAdditions("Platform", {
  resources: [...viewsHelpSupportResources, ...workflowResources, ...a36Resources, ...a84Resources],
  actions: { ...workflowActions, ...a36Actions, ...a84Actions },
  capabilities: {
    ...viewsHelpSupportCapabilities,
    ...workflowCapabilities,
    ...a36Capabilities,
    ...a84Capabilities,
  },
  corrections: [
    ...workflowCorrections,
    ...a36Corrections,
    {
      id: "custom-object-type-default-view",
      since: "1.0.0-draft.2",
      resources: ["customObjectTypes"],
      change: "`default_view` becomes optional on create.",
      reason: "app.custom_object_types (0540) defaults `default_view`.",
      apply: editShape({ optionalOnCreate: ["default_view"] }),
    },
    {
      id: "custom-object-field-order",
      since: "1.0.0-draft.2",
      resources: ["customObjectFields"],
      change:
        "Adds `sort_order` (required on create); `required` and `filterable` become optional on create.",
      reason:
        "app.custom_object_fields (0540) has a NOT NULL `sort_order` without a default and defaults `required` and `filterable` to false.",
      apply: editShape({
        optionalOnCreate: ["required", "filterable"],
        add: {
          sort_order: {
            schema: fields.int("Position in forms and tables.", 1),
            create: "required",
          },
        },
      }),
    },
    {
      id: "custom-object-record-type",
      since: "1.0.0-draft.2",
      resources: ["objects"],
      change:
        "Adds the server-set `custom_object_type_id`, resolved from the `object_key` path segment. `values` stays, read from app.custom_object_values.",
      reason:
        "app.custom_object_records (0540) belongs to its object type by `custom_object_type_id` (NOT NULL); field values are rows of app.custom_object_values.",
      apply: editShape({
        add: {
          custom_object_type_id: {
            schema: fields.ref("object type the record is an instance of"),
          },
        },
      }),
    },
    {
      id: "custom-object-relation-targets",
      since: "1.0.0-draft.2",
      resources: ["customObjectRelations"],
      change:
        "`custom_object_record_id` becomes `from_record_id` and `target_urn` gives way to one typed target column (`to_custom_record_id`, `to_record_id`, `to_project_id`, `to_counterparty_id` or `to_person_id`); adds `relation_key`.",
      reason:
        "app.custom_object_relations (0540) links a custom object record to exactly one target through typed foreign keys, named by `relation_key`; it stores no URNs.",
      apply: editShape({
        remove: ["custom_object_record_id", "target_urn"],
        add: {
          from_record_id: {
            schema: fields.ref("custom object record the link starts from"),
            create: "required",
            update: false,
          },
          relation_key: {
            schema: fields.code("Name of the relation, such as sponsor or venue.", "sponsor"),
            create: "required",
          },
          to_custom_record_id: optional(orNull(fields.ref("linked custom object record"))),
          to_record_id: optional(orNull(fields.ref("linked record"))),
          to_project_id: optional(orNull(fields.ref("linked project"))),
          to_counterparty_id: optional(orNull(fields.ref("linked counterparty organization"))),
          to_person_id: optional(orNull(fields.ref("linked person"))),
        },
      }),
    },
    {
      id: "custom-field-definition-flags",
      since: "1.0.0-draft.2",
      resources: ["customFieldDefinitions"],
      change: "Adds `required`, `filterable` and `sort_order` (required on create).",
      reason:
        "app.custom_field_definitions (0540) has `required` and `filterable` flags (default false) and a NOT NULL `sort_order` without a default.",
      apply: editShape({
        add: {
          required: optional(fields.bool("True when forms require a value.", false)),
          filterable: optional(
            fields.bool("True when views filter on the field; it adds a partial index.", false),
          ),
          sort_order: { schema: fields.int("Position in forms.", 1), create: "required" },
        },
      }),
    },
    {
      id: "custom-field-value-typed-columns",
      since: "1.0.0-draft.2",
      resources: ["customFieldValues"],
      change:
        "`row_id` becomes `target_id` and `value` becomes `value_text`; adds the typed value columns `value_number`, `value_money_minor` with `value_currency`, `value_date`, `value_timestamp`, `value_boolean`, `value_choice_id` and `value_person_id`.",
      reason:
        "app.custom_field_values (0540) stores one typed column per field type (money in minor units with its currency) for the target row `target_id`, so values stay typed and indexable.",
      apply: editShape({
        rename: { value: "value_text" },
        remove: ["row_id"],
        nullable: ["value_text"],
        add: {
          target_id: {
            schema: fields.ref("row of the field's target table the value belongs to"),
            create: "required",
            update: false,
          },
          value_number: optional(orNull(fields.quantity("Number value.", 12.5))),
          value_money_minor: optional(
            fields.money("Money value in minor units of value_currency.", 250000),
          ),
          value_currency: optional(orNull(fields.currency("ISO 4217 currency of a money value."))),
          value_date: optional(orNull(fields.date("Date value."))),
          value_timestamp: optional(orNull(fields.instant("Timestamp value."))),
          value_boolean: optional(orNull(fields.bool("Boolean value.", true))),
          value_choice_id: optional(orNull(fields.ref("chosen option of the field"))),
          value_person_id: optional(orNull(fields.ref("person value"))),
        },
      }),
    },
    {
      id: "import-job-upload",
      since: "1.0.0-draft.2",
      resources: ["importJobs"],
      change:
        "An import job names its `target_code`, `source`, `original_filename` and `storage_object_path` (required on create) and carries the server-set `import_status` and `mapping_confirmed_at`; removes `source_document_id`, `target_table`, `import_state` and `import_batch_id`.",
      reason:
        "app.import_jobs (0530) records the uploaded file by its bucket path and name, the import target by code, the source format and the wizard status; batches reference the job, not the reverse.",
      apply: editShape({
        remove: ["source_document_id", "target_table", "import_state", "import_batch_id"],
        add: {
          target_code: {
            schema: fields.code("Import target the rows are written to.", "vendors"),
            create: "required",
          },
          source: {
            schema: label(["CSV", "XLSX", "XLS", "Google Sheets"], "Source format."),
            create: "required",
          },
          original_filename: {
            schema: fields.text("File name as uploaded.", "vendors-2026.xlsx", 255),
            create: "required",
          },
          storage_object_path: {
            schema: fields.text(
              "Object path of the uploaded file in the tenant import bucket.",
              "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f/imports/vendors-2026.xlsx",
              1024,
            ),
            create: "required",
          },
          import_status: {
            schema: label(
              [
                "Uploaded",
                "Detected",
                "Mapped",
                "Validated",
                "Committing",
                "Committed",
                "Undone",
                "Failed",
                "Canceled",
              ],
              "Wizard progress.",
            ),
          },
          mapping_confirmed_at: {
            schema: orNull(
              fields.instant(
                "When the person confirmed every column mapping; nothing is validated before it.",
              ),
            ),
          },
        },
      }),
    },
    {
      id: "import-batch-undo",
      since: "1.0.0-draft.2",
      resources: ["importBatches"],
      change: "Adds `undo_reason`; removes `row_count`; `committed_at` becomes nullable.",
      reason:
        "app.import_batches (0530) leaves `committed_at` NULL while committing, records why a batch was undone, and counts rows through app.import_row_results.",
      apply: editShape({
        nullable: ["committed_at"],
        remove: ["row_count"],
        add: {
          undo_reason: {
            schema: orNull(fields.text("Why the batch was undone.", "Wrong sheet imported.", 2000)),
          },
        },
      }),
    },
    {
      id: "import-row-result-columns",
      since: "1.0.0-draft.2",
      resources: ["importRowResults"],
      change:
        "`source_row` gives way to `sheet_name` with `row_number`; adds `import_batch_id`, `target_table`, `target_id`, `write_action`, `before_image`, `undo_outcome` and `undo_reason`.",
      reason:
        "app.import_row_results (0530) identifies the source row by sheet and one-based row number and records the written target, the write action, the before image used by undo and the undo outcome.",
      apply: editShape({
        remove: ["source_row"],
        add: {
          import_batch_id: {
            schema: orNull(
              fields.ref("batch that wrote the row; set exactly when the row is written"),
            ),
          },
          sheet_name: { schema: fields.text("Source sheet.", "Vendors") },
          row_number: {
            schema: fields.int("One-based row number in the sheet, as the person sees it.", 2, 1),
          },
          target_table: { schema: orNull(tableName("Table the row was written to.")) },
          target_id: { schema: orNull(fields.ref("row written, created, updated or merged into")) },
          write_action: {
            schema: orNull(label(["Created", "Updated", "Merged"], "What the write did.")),
          },
          before_image: {
            schema: orNull(
              fields.document(
                "The columns an update or merge changed, as they were before the write; undo restores them.",
              ),
            ),
          },
          undo_outcome: {
            schema: orNull(label(["Reverted", "Kept"], "Outcome when the batch was undone.")),
          },
          undo_reason: {
            schema: orNull(
              fields.text(
                "Why a row was kept: the later edit or the dependent row.",
                "Edited after the import.",
                2000,
              ),
            ),
          },
        },
      }),
    },
    {
      id: "import-mapping-profile-target",
      since: "1.0.0-draft.2",
      resources: ["importMappingProfiles"],
      change: "`target_table` gives way to `target_code`.",
      reason:
        "app.import_mapping_profiles (0530) maps onto an import target by code (app.import_targets), not a table name.",
      apply: editShape({
        remove: ["target_table"],
        add: {
          target_code: {
            schema: fields.code("Import target the profile maps onto.", "vendors"),
            create: "required",
          },
        },
      }),
    },
    {
      id: "merge-review-candidate",
      since: "1.0.0-draft.2",
      resources: ["mergeReviews"],
      change:
        "A review names the `import_row_result_id` and the candidate by `candidate_table` and `candidate_id`, with the server-set `decided_by` and `decided_at`; removes `import_job_id`, `candidate_urn` and `existing_urn`.",
      reason:
        "app.merge_reviews (0530) ties a possible duplicate to the import row that matched and the existing row by table and id, and stamps who decided and when.",
      apply: editShape({
        remove: ["import_job_id", "candidate_urn", "existing_urn"],
        add: {
          import_row_result_id: { schema: fields.ref("import row that matched") },
          candidate_table: { schema: tableName("Table of the existing row.") },
          candidate_id: { schema: fields.ref("existing row it may duplicate") },
          decided_by: { schema: orNull(fields.ref("person who decided, set from the session")) },
          decided_at: { schema: orNull(fields.instant("When they decided, set by the database.")) },
        },
      }),
    },
    {
      id: "export-job-columns",
      since: "1.0.0-draft.2",
      resources: ["exportJobs"],
      change:
        "`source` becomes `source_label` and `format` becomes `export_format`; adds the server-set `classification`, `watermark`, `export_status`, `storage_object_path`, `row_count` and `expires_at`; removes `export_state` and `document_id`.",
      reason:
        "app.export_jobs (0530) labels the source, computes the highest column classification and the watermark when the export is requested, tracks `export_status`, and keeps the rendered file at a bucket path with an expiry instead of a document.",
      apply: editShape({
        rename: { source: "source_label", format: "export_format" },
        remove: ["export_state", "document_id"],
        add: {
          classification: { schema: Classification },
          watermark: {
            schema: fields.bool(
              "True for Confidential and Restricted exports: PDFs and images carry the viewer email and time.",
              false,
            ),
          },
          export_status: {
            schema: label(
              ["Queued", "Rendering", "Ready", "Failed", "Expired"],
              "Export progress.",
            ),
          },
          storage_object_path: {
            schema: orNull(
              fields.text(
                "Object path of the file once ready.",
                "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f/exports/vendors.csv",
                1024,
              ),
            ),
          },
          row_count: { schema: orNull(fields.int("Rows exported.", 120)) },
          expires_at: { schema: orNull(fields.instant("When the download link stops working.")) },
        },
      }),
    },
    {
      id: "saved-view-collection",
      since: "1.0.0-draft.2",
      resources: ["savedViews"],
      change:
        "A view belongs to a `membership_id` and shows a `collection_key`, with `group_by_field`; removes `collection` and `query` (filters and sorts are rows of app.saved_view_filters and app.saved_view_sorts); `shared` becomes optional on create.",
      reason:
        "app.saved_views (0540) is owned by an org membership, keys the collection it shows, stores filters and sorts as child rows and defaults `shared` to false.",
      apply: editShape({
        remove: ["collection", "query"],
        optionalOnCreate: ["shared"],
        add: {
          membership_id: {
            schema: fields.ref("member who owns the view"),
            create: "required",
            update: false,
          },
          collection_key: {
            schema: fields.text(
              "Collection the view shows, such as records or objects/sponsors.",
              "records",
            ),
            create: "required",
            update: false,
          },
          group_by_field: optional(
            orNull(fields.code("Field rows are grouped by, if any.", "record_state")),
          ),
        },
      }),
    },
    {
      id: "comment-thread-subject",
      since: "1.0.0-draft.2",
      resources: ["commentThreads"],
      change:
        "`subject_urn` becomes `subject_table` with `subject_id`; adds `anchor`; `resolved` gives way to `resolved_at` (set on update) and the server-set `resolved_by`.",
      reason:
        "app.comment_threads (0580) addresses the subject by table and id (app.comment_subjects lists the commentable tables), anchors a thread to part of it, and records resolution as a time and a person.",
      apply: editShape({
        remove: ["subject_urn", "resolved"],
        add: {
          subject_table: {
            schema: tableName("Table of the subject, one of app.comment_subjects."),
            create: "required",
            update: false,
          },
          subject_id: {
            schema: fields.ref("row the thread is about"),
            create: "required",
            update: false,
          },
          anchor: optional(
            orNull(
              fields.text(
                "Part of the subject the thread is anchored to; null for the main thread.",
                "line:12",
              ),
            ),
          ),
          resolved_at: {
            schema: orNull(fields.instant("When the thread was resolved; null while open.")),
            update: true,
          },
          resolved_by: {
            schema: orNull(fields.ref("person who resolved it, set from the session")),
          },
        },
      }),
    },
    {
      id: "comment-text-body",
      since: "1.0.0-draft.2",
      resources: ["comments"],
      change:
        "`body` is text, `author_id` becomes `author_person_id`, and adds `source` and the server-set `edited_at`.",
      reason:
        "app.comments (0580) stores the comment as text with mentions in app.comment_mentions, stamps the author from the session, records where it came from (App, Email or API) and when it was last edited.",
      apply: editShape({
        rename: { author_id: "author_person_id" },
        add: {
          body: {
            schema: fields.text(
              "Comment text; mentions are recorded separately.",
              "Load-in moved to 07:00.",
              10000,
            ),
            create: "required",
          },
          source: optional(label(["App", "Email", "API"], "Where the comment came from.")),
          edited_at: { schema: orNull(fields.instant("When the text was last edited.")) },
        },
      }),
    },
    {
      id: "notification-subject-columns",
      since: "1.0.0-draft.2",
      resources: ["notifications"],
      change:
        "`created_for` becomes `recipient_person_id`; adds `actor_person_id`, `subject_table`, `subject_id`, `project_id`, `message_args` and `archived_at`; removes `subject_urn` and `deep_link`.",
      reason:
        "app.notifications (0520) addresses the recipient and subject by id and table, carries ICU message arguments for the kind's catalog text, and records archiving; links are built from the subject, so no deep link or URN is stored.",
      apply: editShape({
        rename: { created_for: "recipient_person_id" },
        remove: ["subject_urn", "deep_link"],
        add: {
          recipient_person_id: { schema: fields.ref("person the notification is for") },
          actor_person_id: {
            schema: orNull(fields.ref("person whose action caused it, when one did")),
          },
          subject_table: { schema: orNull(tableName("Table of the record it is about.")) },
          subject_id: { schema: orNull(fields.ref("record it is about")) },
          project_id: {
            schema: orNull(fields.ref("project of the record, when it belongs to one")),
          },
          message_args: {
            schema: fields.document(
              "ICU message arguments for the kind's catalog messages, such as a record title.",
            ),
          },
          archived_at: {
            schema: orNull(fields.instant("When the recipient archived it.")),
            update: true,
          },
        },
      }),
    },
    {
      id: "notification-preference-category",
      since: "1.0.0-draft.2",
      resources: ["notificationPreferences"],
      change:
        "`kind` gives way to `category_code`; adds `membership_id`; `channel` is the database enum.",
      reason:
        "app.notification_preferences (0520) sets preferences per org membership and notification category, and takes `channel` from app.notification_channel (In App, Email, SMS, Push), which the Title Case pattern rejects.",
      apply: editShape({
        remove: ["kind"],
        add: {
          membership_id: {
            schema: fields.ref("membership whose preference this is; preferences are per org"),
            create: "required",
            update: false,
          },
          category_code: {
            schema: fields.code("Notification category.", "approvals"),
            create: "required",
            update: false,
          },
          channel: {
            schema: label(["In App", "Email", "SMS", "Push"], "Delivery channel."),
            create: "required",
            update: false,
          },
        },
      }),
    },
    {
      id: "calendar-feed-owner",
      since: "1.0.0-draft.2",
      resources: ["calendarFeeds"],
      change: "Adds `membership_id` (required on create) and the server-set `last_accessed_at`.",
      reason:
        "app.calendar_feeds (0550) belongs to an org membership, whose access decides what the feed shows, and records the last fetch.",
      apply: editShape({
        add: {
          membership_id: {
            schema: fields.ref("member who owns the feed; it shows what they may see"),
            create: "required",
            update: false,
          },
          last_accessed_at: {
            schema: orNull(fields.instant("Last time a calendar fetched the feed.")),
          },
        },
      }),
    },
    {
      id: "calendar-feed-create-returns-token",
      since: "1.0.0-draft.2",
      resources: ["calendarFeeds"],
      components: ["schemas/CalendarFeedToken"],
      change:
        "CalendarFeedCreate takes only `project_id`: the owning membership is the caller's. `calendarFeeds.create` answers 201 with CalendarFeedToken (`calendar_feed_id` and the `feed_token`, shown once) instead of the CalendarFeed read shape.",
      reason:
        "app.create_calendar_feed (0550) creates the feed for the caller's own membership in the organization and stores only the token's hash, returning the token once; answering with the read shape would lose the only copy of the subscription URL's token.",
      apply: all(
        editShape({
          add: {
            membership_id: {
              schema: fields.ref("member who owns the feed; it shows what they may see"),
              update: false,
            },
          },
        }),
        createAnswering(
          CalendarFeedToken,
          "app.create_calendar_feed",
          "Create a calendar feed",
          "Creates an iCalendar feed of the caller's schedule, optionally for one project, through `app.create_calendar_feed`. The token of the subscription URL is returned once.",
        ),
      ),
    },
    {
      id: "export-job-requested-columns",
      since: "1.0.0-draft.2",
      resources: ["exportJobs"],
      change:
        "ExportJobCreate takes the write-only `columns` (required): the `app.table.column` names the export contains.",
      reason:
        "app.request_export (0530) refuses an export that names no columns and computes the classification and watermark from them (Section 8.6); the frozen create body could not name them.",
      apply: editShape({
        add: {
          columns: {
            schema: z
              .array(
                z
                  .string()
                  .regex(/^app\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/)
                  .meta({
                    description: "A column as app.table.column.",
                    example: "app.vendors.name",
                  }),
              )
              .min(1)
              .meta({ description: "Columns the export contains, as app.table.column." }),
            create: "required",
            update: false,
            read: false,
          },
        },
      }),
    },
  ],
});
