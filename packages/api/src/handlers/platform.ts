/**
 * Platform handlers (A18 schema, A04P handlers): custom objects, their fields, records and
 * relations, custom fields on built-in tables, imports, merge reviews, exports, saved views,
 * comments, notifications and their preferences, and calendar feeds. Tables are read and written as
 * the caller, so row level security and the column guards decide; comments are posted through
 * app.post_comment, exports requested through app.request_export (which classifies the columns),
 * import batches undone through app.undo_import_batch, notifications marked read through
 * app.mark_notifications_read and calendar feeds created through app.create_calendar_feed, which
 * returns the feed token once. Approvals, Trash, templates and org state labels are A33's
 * (handlers/parts/workflow.ts). Support sessions, wholesale statements, acting on a notification and
 * the import dry run and commit request are A36's (handlers/parts/a36.ts); the import worker validates
 * and writes the rows with the service role.
 */
import type { XosClient } from "@xos/data";
import { editComment, deleteComment, postComment, setThreadResolved } from "@xos/data/comments";
import type { Components } from "../contract/operations.generated.ts";
import { notFound, refused } from "../problem.ts";
import type { RequestContext } from "../runtime/context.ts";
import { requireOrg } from "../runtime/context.ts";
import { assertIfMatch } from "../runtime/etag.ts";
import type { HandlerSet } from "../runtime/handler.ts";
import { created, defineHandlers, noContent, ok } from "../runtime/handler.ts";
import type { ListQuery } from "../runtime/listing.ts";
import { selectColumns } from "../runtime/pagination.ts";
import { viewsHelpSupportHandlers } from "./parts/views-help-support.ts";
import { a36Handlers } from "./parts/a36.ts";
import { a79PlatformHandlers } from "./parts/a79.ts";
import { workflowHandlers } from "./parts/workflow.ts";
import { from, handlersFor, rpc, run, tableResource, unwrap } from "./support/table.ts";
import type { Row } from "./support/table.ts";

// Custom object records: values are rows of app.custom_object_values, one typed column per field ---

/** The value column each custom data type stores into (private.check_typed_value, 0540). */
const VALUE_COLUMN: Readonly<Record<string, string>> = {
  Text: "value_text",
  Email: "value_text",
  URL: "value_text",
  Number: "value_number",
  Money: "value_money_minor",
  Date: "value_date",
  Timestamp: "value_timestamp",
  Boolean: "value_boolean",
  Choice: "value_choice_id",
  Person: "value_person_id",
};
const VALUE_COLUMNS = [...new Set(Object.values(VALUE_COLUMN))];

interface FieldRow {
  id: string;
  field_key: string;
  data_type: string;
}

async function fieldsOf(db: XosClient, typeId: unknown): Promise<FieldRow[]> {
  return run<FieldRow[]>(
    from(db, "custom_object_fields")
      .select("id, field_key, data_type")
      .eq("custom_object_type_id", typeId)
      .is("deleted_at", null),
  );
}

async function valuesOf(db: XosClient, record: Row): Promise<Row> {
  const [fields, values] = await Promise.all([
    fieldsOf(db, record["custom_object_type_id"]),
    run<Row[]>(
      from(db, "custom_object_values")
        .select(`custom_object_field_id, ${VALUE_COLUMNS.join(", ")}`)
        .eq("custom_object_record_id", record["id"])
        .is("deleted_at", null),
    ),
  ]);
  const out: Row = {};
  for (const field of fields) {
    const value = values.find((v) => v["custom_object_field_id"] === field.id);
    const column = VALUE_COLUMN[field.data_type] as string;
    out[field.field_key] = value === undefined ? null : (value[column] ?? null);
  }
  return out;
}

/** Writes each member of `values` to its field's typed column, replacing the earlier value. */
async function writeValues(db: XosClient, record: Row, values: Readonly<Record<string, unknown>>) {
  const fields = await fieldsOf(db, record["custom_object_type_id"]);
  for (const [key, value] of Object.entries(values)) {
    const field = fields.find((f) => f.field_key === key);
    if (field === undefined) {
      throw refused("REFUSE", `${key} is not a field of this object.`, "custom_value_field");
    }
    if (field.data_type === "Money" && value !== null) {
      throw refused(
        "REFUSE",
        `${key} is a Money field: a money value carries its currency, which the values map cannot. Set it with the currency in Atlas.`,
        "custom_value_currency",
      );
    }
    const column = VALUE_COLUMN[field.data_type] as string;
    const existing = await run<{ id: string } | null>(
      from(db, "custom_object_values")
        .select("id")
        .eq("custom_object_record_id", record["id"])
        .eq("custom_object_field_id", field.id)
        .is("deleted_at", null)
        .maybeSingle(),
    );
    if (existing === null) {
      await run(
        from(db, "custom_object_values").insert({
          custom_object_record_id: record["id"],
          custom_object_field_id: field.id,
          [column]: value,
        }),
      );
    } else {
      await run(
        from(db, "custom_object_values")
          .update({ [column]: value })
          .eq("id", existing.id),
      );
    }
  }
}

const objects = tableResource("objects", {
  verbs: [],
  derived: ["values"],
  toContract: async (row, { db }) => ({ ...row, values: await valuesOf(db, row) }),
});

/** The custom object type the path names, or 404. */
async function objectType(db: XosClient, objectKey: string): Promise<string> {
  const type = await run<{ id: string } | null>(
    from(db, "custom_object_types")
      .select("id")
      .eq("object_key", objectKey)
      .is("deleted_at", null)
      .maybeSingle(),
  );
  if (type === null) throw notFound(`No custom object ${objectKey} is visible to you.`);
  return type.id;
}

/** A record of the named type, or 404 when it belongs to another type. */
async function objectRecord(
  context: RequestContext,
  objectKey: string,
  id: string,
  fields?: readonly string[],
) {
  const typeId = await objectType(context.db, objectKey);
  const record = await objects.read(
    context,
    id,
    fields === undefined ? objects.fields : [...new Set([...fields, "custom_object_type_id"])],
  );
  if (record["custom_object_type_id"] !== typeId) throw notFound();
  return record;
}

// Comments and threads --------------------------------------------------------------------------------

const commentThreads = tableResource("commentThreads", { verbs: ["list", "get", "create"] });
const comments = tableResource("comments", { verbs: ["list", "get"] });

// Imports, exports, notifications and feeds ------------------------------------------------------------

const importBatches = tableResource("importBatches", { verbs: ["list", "get"] });
const exportJobs = tableResource("exportJobs", { verbs: ["list", "get"] });
const notifications = tableResource("notifications");
const calendarFeeds = tableResource("calendarFeeds", { verbs: ["list", "get"] });

type Thread = Components["CommentThread"];
type Comment = Components["Comment"];

export const handlers = defineHandlers("Platform", {
  ...handlersFor("Platform", tableResource("customObjectTypes")),
  ...handlersFor("Platform", tableResource("customObjectFields")),
  ...handlersFor("Platform", tableResource("customObjectRelations")),
  ...handlersFor("Platform", tableResource("customFieldDefinitions")),
  ...handlersFor("Platform", tableResource("customFieldValues")),

  "objects.list": async ({ params, query }, context) => {
    const typeId = await objectType(context.db, params.object_key);
    const filter = { ...(query.filter ?? {}), custom_object_type_id: { eq: typeId } };
    return ok((await objects.list(context, { ...(query as ListQuery), filter })) as never);
  },
  "objects.get": async ({ params, query }, context) => {
    const wanted = selectColumns(query.fields, objects.fields, "id");
    const record = await objectRecord(context, params.object_key, params.id, wanted);
    return ok(Object.fromEntries(wanted.map((f) => [f, record[f]])) as never);
  },
  "objects.create": async ({ params, body }, context) => {
    const typeId = await objectType(context.db, params.object_key);
    const inserted = await run<{ id: string }>(
      from(context.db, "custom_object_records")
        .insert({
          org_id: requireOrg(context).id,
          custom_object_type_id: typeId,
          title: body.title,
        })
        .select("id")
        .single(),
    );
    await writeValues(context.db, { id: inserted.id, custom_object_type_id: typeId }, body.values);
    return created((await objectRecord(context, params.object_key, inserted.id)) as never);
  },
  "objects.update": async ({ params, body, ifMatch }, context) => {
    const current = await objectRecord(context, params.object_key, params.id);
    assertIfMatch(ifMatch ?? "*", current);
    if (body.title !== undefined) {
      await run(
        from(context.db, "custom_object_records").update({ title: body.title }).eq("id", params.id),
      );
    }
    if (body.values !== undefined) await writeValues(context.db, current, body.values);
    return ok((await objectRecord(context, params.object_key, params.id)) as never);
  },
  "objects.delete": async ({ params }, context) => {
    await objectRecord(context, params.object_key, params.id, ["id"]);
    await run(
      from(context.db, "custom_object_records")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", params.id),
    );
    return noContent();
  },

  ...handlersFor("Platform", tableResource("importJobs", { verbs: ["list", "get", "create"] })),
  ...handlersFor("Platform", importBatches),
  "importBatches.undo": async ({ params }, context) => {
    await importBatches.read(context, params.id, ["id"]);
    await run(
      rpc(context.db, "undo_import_batch", {
        p_import_batch_id: params.id,
        p_reason: "Undone through the API.",
      }),
    );
    return ok((await importBatches.read(context, params.id)) as Components["ImportBatch"]);
  },
  ...handlersFor("Platform", tableResource("importRowResults")),
  ...handlersFor("Platform", tableResource("importMappingProfiles")),
  ...handlersFor("Platform", tableResource("mergeReviews")),

  ...handlersFor("Platform", exportJobs),
  "exportJobs.create": async ({ body }, context) => {
    const id = await run<string>(
      rpc(context.db, "request_export", {
        p_org_id: requireOrg(context).id,
        p_format: body.export_format,
        p_source_label: body.source_label,
        p_columns: [...body.columns],
      }),
    );
    return created((await exportJobs.read(context, id)) as Components["ExportJob"]);
  },

  ...handlersFor("Platform", tableResource("savedViews")),
  ...(viewsHelpSupportHandlers as unknown as HandlerSet<"Platform">),
  ...(workflowHandlers as unknown as HandlerSet<"Platform">),
  ...(a36Handlers as unknown as HandlerSet<"Platform">),
  ...(a79PlatformHandlers as unknown as HandlerSet<"Platform">),

  ...handlersFor("Platform", commentThreads),
  "commentThreads.update": async ({ params, body, ifMatch }, context) => {
    const current = await commentThreads.read(context, params.id);
    assertIfMatch(ifMatch ?? "*", current);
    if (body.anchor !== undefined) {
      await run(
        from(context.db, "comment_threads").update({ anchor: body.anchor }).eq("id", params.id),
      );
    }
    if (body.resolved_at !== undefined) {
      unwrap(await setThreadResolved(context.db, params.id, body.resolved_at !== null));
    }
    return ok((await commentThreads.read(context, params.id)) as Thread);
  },

  ...handlersFor("Platform", comments),
  // A comment is posted on its thread's subject and anchor (app.post_comment), which stamps the
  // author and checks mentions.
  "comments.create": async ({ body }, context) => {
    const thread = (await commentThreads.read(context, body.comment_thread_id)) as Thread;
    const id = unwrap(
      await postComment(context.db, {
        subject: { table: thread.subject_table, id: thread.subject_id },
        body: body.body,
        ...(thread.anchor === null ? {} : { anchor: thread.anchor }),
      }),
    );
    return created((await comments.read(context, id)) as Comment);
  },
  "comments.update": async ({ params, body, ifMatch }, context) => {
    const current = await comments.read(context, params.id);
    assertIfMatch(ifMatch ?? "*", current);
    if (body.body !== undefined) unwrap(await editComment(context.db, params.id, body.body));
    return ok((await comments.read(context, params.id)) as Comment);
  },
  "comments.delete": async ({ params }, context) => {
    await comments.read(context, params.id, ["id"]);
    unwrap(await deleteComment(context.db, params.id));
    return noContent();
  },

  ...handlersFor("Platform", notifications),
  "notifications.markAllRead": async (_request, context) => {
    const count = await run<number>(
      rpc(context.db, "mark_notifications_read", { p_org_id: requireOrg(context).id }),
    );
    return ok({ updated_count: count });
  },
  ...handlersFor("Platform", tableResource("notificationPreferences")),

  ...handlersFor("Platform", calendarFeeds),
  "calendarFeeds.create": async ({ body }, context) => {
    const rows = await run<{ calendar_feed_id: string; feed_token: string }[]>(
      rpc(context.db, "create_calendar_feed", {
        p_org_id: requireOrg(context).id,
        ...((body.project_id ?? null) === null ? {} : { p_project_id: body.project_id }),
      }),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("create_calendar_feed returned no row.");
    return created(row);
  },
  // Removing a feed revokes it: the subscription URL stops working at once.
  "calendarFeeds.delete": async ({ params }, context) => {
    await calendarFeeds.read(context, params.id, ["id"]);
    await run(
      from(context.db, "calendar_feeds")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", params.id)
        .is("revoked_at", null),
    );
    return noContent();
  },
} satisfies HandlerSet<"Platform">);
