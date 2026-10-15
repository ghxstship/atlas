/**
 * Activity handlers (A07): the user-facing feed (Section 4.2 Activity) through app.activity_feed,
 * which applies the feed rule (activity.feed.read, and invariant 2 for project events). Newest
 * first; the cursor carries the time of the last entry returned.
 */
import { getActivityEntry, listActivity, type ActivityEntry } from "@xos/data/activity";
import type { Components } from "../contract/operations.generated.ts";
import { requireOrg } from "../runtime/context.ts";
import { defineHandlers, ok } from "../runtime/handler.ts";
import { decodeCursor, encodeCursor, pageSize } from "../runtime/pagination.ts";
import { problemFor } from "./projects.ts";

type ActivityEvent = Components["ActivityEvent"];

function toEvent(orgId: string, e: ActivityEntry): ActivityEvent {
  return {
    id: e.id,
    org_id: orgId,
    created_at: e.at,
    created_by: e.actorPersonId as string,
    updated_at: e.at,
    updated_by: e.actorPersonId as string,
    actor_id: e.actorPersonId as string,
    verb: e.type,
    subject_urn: `urn:xpms:${e.subjectTable}:${e.subjectId}`,
    project_id: e.project?.id ?? null,
    occurred_at: e.at,
    summary: e.description ?? e.type,
  };
}

export const handlers = defineHandlers("Activity", {
  "activityEvents.list": async ({ query }, context) => {
    const org = requireOrg(context);
    const size = pageSize(query.limit);
    const before =
      query.cursor === undefined
        ? null
        : String(decodeCursor(query.cursor, ["occurred_at"])["occurred_at"]);
    const project = query.filter?.["project_id"]?.eq ?? null;
    const page = await listActivity(context.db, {
      orgId: org.id,
      projectId: project,
      before,
      limit: size,
    });
    if (!page.ok) throw problemFor(page.error);
    const last = page.data.entries[page.data.entries.length - 1];
    return ok({
      data: page.data.entries.map((e) => toEvent(org.id, e)),
      next_cursor: page.data.next !== null && last ? encodeCursor({ occurred_at: last.at }) : null,
    } as Components["ActivityEventPage"]);
  },

  "activityEvents.get": async ({ params }, context) => {
    const org = requireOrg(context);
    const entry = await getActivityEntry(context.db, org.id, params.id);
    if (!entry.ok) throw problemFor(entry.error);
    return ok(toEvent(org.id, entry.data));
  },
});
