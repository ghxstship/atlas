/**
 * A84 handlers (RRR-129, migrations 1410 and 1411, ADR 0040): calendar feed rotation, a person's
 * own feed across their engagements, the project inbox address, and filing or discarding inbound
 * mail. handlers/platform.ts spreads them. Every call runs as the caller: row level security and
 * the RPCs decide, and refusals answer 422 with the rule. Shapes follow
 * catalog/modules/parts/a84.ts.
 */
import { notFound } from "../../problem.ts";
import type { RequestContext } from "../../runtime/context.ts";
import type { ErasedHandler } from "../../runtime/handler.ts";
import { created, noContent, ok } from "../../runtime/handler.ts";
import { from, rpc, run, tableResource, type Row } from "../support/table.ts";

const calendarFeeds = tableResource("calendarFeeds", { verbs: ["list", "get"] });
const personCalendarFeeds = tableResource("personCalendarFeeds", { verbs: ["list", "get"] });
const projectInboxes = tableResource("projectInboxes", { verbs: ["list", "get"] });
const inboundMessages = tableResource("inboundMessages", { verbs: ["list", "get"] });

/** The token row a feed RPC returns: `calendar_feed_id` and the `feed_token`, shown once. */
function token(rows: Row[]): Row {
  const row = rows[0];
  if (row === undefined) throw notFound("No calendar feed with this identifier is visible to you.");
  return { calendar_feed_id: row["calendar_feed_id"], feed_token: row["feed_token"] };
}

/** The inbox address row a project inbox RPC named by its local part. */
async function inboxByLocalPart(context: RequestContext, localPart: unknown) {
  const row = await run<Row | null>(
    from(context.db, "inbound_addresses").select("id").eq("local_part", localPart).maybeSingle(),
  );
  if (row === null) throw notFound("No project inbox with this address is visible to you.");
  return projectInboxes.read(context, String(row["id"]));
}

export const a84Handlers: Readonly<Record<string, ErasedHandler>> = {
  "calendarFeeds.rotate": async (request, context) => {
    const id = String(request.params["id"]);
    await calendarFeeds.read(context, id, ["id"]);
    return ok(
      token(await run<Row[]>(rpc(context.db, "rotate_calendar_feed", { p_calendar_feed_id: id }))),
    );
  },

  ...personCalendarFeeds.handlers,
  "personCalendarFeeds.create": async (_request, context) =>
    created(token(await run<Row[]>(rpc(context.db, "create_person_calendar_feed")))),
  "personCalendarFeeds.rotate": async (request, context) => {
    const id = String(request.params["id"]);
    await personCalendarFeeds.read(context, id, ["id"]);
    return ok(
      token(
        await run<Row[]>(
          rpc(context.db, "rotate_person_calendar_feed", { p_calendar_feed_id: id }),
        ),
      ),
    );
  },
  // Deleting a feed revokes it: the subscription URL stops working at once, for good.
  "personCalendarFeeds.delete": async (request, context) => {
    const id = String(request.params["id"]);
    await personCalendarFeeds.read(context, id, ["id"]);
    await run(
      from(context.db, "person_calendar_feeds")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", id)
        .is("revoked_at", null),
    );
    return noContent();
  },

  ...projectInboxes.handlers,
  "projectInboxes.create": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const local = await run<string>(
      rpc(context.db, "create_project_inbox", { p_project_id: body["project_id"] }),
    );
    return created(await inboxByLocalPart(context, local));
  },
  "projectInboxes.replace": async (request, context) => {
    const current = await projectInboxes.read(context, String(request.params["id"]), [
      "project_id",
    ]);
    const local = await run<string>(
      rpc(context.db, "replace_project_inbox", { p_project_id: current["project_id"] }),
    );
    return ok(await inboxByLocalPart(context, local));
  },
  "projectInboxes.disable": async (request, context) => {
    const id = String(request.params["id"]);
    const current = await projectInboxes.read(context, id, ["project_id"]);
    await run(rpc(context.db, "disable_project_inbox", { p_project_id: current["project_id"] }));
    return ok(await projectInboxes.read(context, id));
  },

  ...inboundMessages.handlers,
  "inboundMessages.file": async (request, context) => {
    const id = String(request.params["id"]);
    const body = (request.body ?? {}) as Row;
    await inboundMessages.read(context, id, ["id"]);
    await run(
      rpc(context.db, "file_inbound_message", {
        p_inbound_message_id: id,
        p_title: body["title"] ?? null,
        p_record_id: body["record_id"] ?? null,
      }),
    );
    return ok(await inboundMessages.read(context, id));
  },
  "inboundMessages.discard": async (request, context) => {
    const id = String(request.params["id"]);
    const body = (request.body ?? {}) as Row;
    await inboundMessages.read(context, id, ["id"]);
    await run(
      rpc(context.db, "discard_inbound_message", {
        p_inbound_message_id: id,
        p_reason: body["reason"] ?? null,
      }),
    );
    return ok(await inboundMessages.read(context, id));
  },
};
