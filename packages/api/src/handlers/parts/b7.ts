/**
 * B7 handlers (RRR-231, migrations 2960 to 2965, ADR 0146): a calendar feed's configuration, and the project
 * debrief. Every call runs as the caller: row level security and the RPCs decide, and refusals answer 422 with the
 * rule. Shapes follow catalog/modules/parts/b7.ts. handlers/platform.ts and handlers/projects.ts spread them.
 */
import { notFound } from "../../problem.ts";
import type { ErasedHandler } from "../../runtime/handler.ts";
import { ok } from "../../runtime/handler.ts";
import type { RequestContext } from "../../runtime/context.ts";
import { from, rpc, run, tableHandlers, tableResource, type Row } from "../support/table.ts";

const projectDebriefs = tableResource("projectDebriefs", { verbs: ["list", "get"] });

type Audience = {
  kind?: unknown;
  person_ids?: unknown;
  team_id?: unknown;
  department_code?: unknown;
} | null;

/** The configure RPC's arguments from the request body; a field left out is cleared. */
function configurationArgs(body: Row): Record<string, unknown> {
  const audience = (body["audience"] ?? null) as Audience;
  return {
    p_name: typeof body["name"] === "string" && body["name"].trim() !== "" ? body["name"] : null,
    p_sources: Array.isArray(body["sources"]) ? body["sources"] : null,
    p_person_ids:
      audience?.kind === "people" && Array.isArray(audience.person_ids)
        ? audience.person_ids
        : null,
    p_team_id: audience?.kind === "team" ? (audience.team_id ?? null) : null,
    p_department_code: audience?.kind === "department" ? (audience.department_code ?? null) : null,
    p_cue_call_kind: body["cue_call_kind"] ?? null,
  };
}

/** A live member or project feed of the caller's, with its configuration, or 404. */
async function feedConfiguration(context: RequestContext, id: string): Promise<Row> {
  const feed = await run<Row | null>(
    from(context.db, "calendar_feeds")
      .select("id, name, sources, team_id, department_code, cue_call_kind")
      .eq("id", id)
      .is("revoked_at", null)
      .is("deleted_at", null)
      .maybeSingle(),
  );
  if (feed === null) throw notFound("No calendar feed with this identifier is visible to you.");
  let audience: Row | null = null;
  if (feed["team_id"]) audience = { kind: "team", team_id: feed["team_id"] };
  else if (feed["department_code"])
    audience = { kind: "department", department_code: feed["department_code"] };
  else {
    const members = await run<Row[]>(
      from(context.db, "calendar_feed_members")
        .select("membership:memberships!inner(person_id)")
        .eq("calendar_feed_id", id)
        .is("deleted_at", null),
    );
    const people = members.flatMap((m) => {
      const person = (m["membership"] as Row | null)?.["person_id"];
      return typeof person === "string" ? [person] : [];
    });
    if (people.length > 0) audience = { kind: "people", person_ids: people };
  }
  return {
    calendar_feed_id: feed["id"],
    name: feed["name"] ?? null,
    sources: feed["sources"] ?? null,
    audience,
    cue_call_kind: feed["cue_call_kind"] ?? null,
  };
}

async function personFeedConfiguration(context: RequestContext, id: string): Promise<Row> {
  const feed = await run<Row | null>(
    from(context.db, "person_calendar_feeds")
      .select("id, name, sources")
      .eq("id", id)
      .is("revoked_at", null)
      .is("deleted_at", null)
      .maybeSingle(),
  );
  if (feed === null) throw notFound("No calendar feed with this identifier is visible to you.");
  return {
    calendar_feed_id: feed["id"],
    name: feed["name"] ?? null,
    sources: feed["sources"] ?? null,
  };
}

export const b7PlatformHandlers: Readonly<Record<string, ErasedHandler>> = {
  "calendarFeeds.configuration": async (request, context) =>
    ok(await feedConfiguration(context, String(request.params["id"]))),
  "calendarFeeds.configure": async (request, context) => {
    const id = String(request.params["id"]);
    await feedConfiguration(context, id);
    await run(
      rpc(context.db, "configure_calendar_feed", {
        p_calendar_feed_id: id,
        ...configurationArgs((request.body ?? {}) as Row),
      }),
    );
    return ok(await feedConfiguration(context, id));
  },
  "personCalendarFeeds.configuration": async (request, context) =>
    ok(await personFeedConfiguration(context, String(request.params["id"]))),
  "personCalendarFeeds.configure": async (request, context) => {
    const id = String(request.params["id"]);
    const body = (request.body ?? {}) as Row;
    await personFeedConfiguration(context, id);
    await run(
      rpc(context.db, "configure_person_calendar_feed", {
        p_calendar_feed_id: id,
        p_name:
          typeof body["name"] === "string" && body["name"].trim() !== "" ? body["name"] : null,
        p_sources: Array.isArray(body["sources"]) ? body["sources"] : null,
      }),
    );
    return ok(await personFeedConfiguration(context, id));
  },
};

export const b7ProjectHandlers: Readonly<Record<string, ErasedHandler>> = {
  ...projectDebriefs.handlers,
  "projectDebriefs.save": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const id = await run<string>(
      rpc(context.db, "save_project_debrief", {
        p_project_id: body["project_id"],
        p_management_summary: body["management_summary"] ?? null,
        p_ai_request_id: body["ai_request_id"] ?? null,
      }),
    );
    return ok(await projectDebriefs.read(context, id));
  },
  "projectDebriefs.complete": async (request, context) => {
    const id = String(request.params["id"]);
    await projectDebriefs.read(context, id, ["id"]);
    await run(rpc(context.db, "complete_project_debrief", { p_project_debrief_id: id }));
    return ok(await projectDebriefs.read(context, id));
  },
  "projectDebriefs.reopen": async (request, context) => {
    const id = String(request.params["id"]);
    await projectDebriefs.read(context, id, ["id"]);
    await run(rpc(context.db, "reopen_project_debrief", { p_project_debrief_id: id }));
    return ok(await projectDebriefs.read(context, id));
  },
  ...(tableHandlers("Projects", "projectDebriefItems") as unknown as Record<string, ErasedHandler>),
};
