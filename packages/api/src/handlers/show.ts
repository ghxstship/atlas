/**
 * Show handlers (A08 schema, A04P handlers): running orders, cues, day sheets and call sheets.
 * Every read and write runs as the caller, so row level security decides; the database stamps a
 * cue's project from its running order, calls a cue once through app.call_cue (time and caller),
 * and stamps a sheet's publication once, refusing a second publish or an edit after publishing
 * with the rule. A cue's department calls (cueCalls, app.cue_calls) are rows of their own, one per department.
 * See packages/api/README.md and ADR 0023 (run-of-show, cue and sheet columns).
 */
import { callCue, publishSheet } from "@xos/data/show";
import { defineHandlers, ok } from "../runtime/handler.ts";
import { notFound } from "../problem.ts";
import { from, handlersFor, run, tableResource, unwrap } from "./support/table.ts";

const cues = tableResource("cues", {
  // The running order fixes the cue's project; reading it also answers 404 for a hidden one.
  beforeCreate: async (body, { db }) => {
    const parent = await run<{ project_id: string } | null>(
      from(db, "run_of_show")
        .select("project_id")
        .eq("id", body["run_of_show_id"])
        .is("deleted_at", null)
        .maybeSingle(),
    );
    if (parent === null) throw notFound("No running order with this identifier is visible to you.");
    return { project_id: parent.project_id };
  },
});
const daySheets = tableResource("daySheets");
const callSheets = tableResource("callSheets");

export const handlers = defineHandlers("Show", {
  ...handlersFor("Show", tableResource("runsOfShow")),
  ...handlersFor("Show", cues),
  ...handlersFor("Show", daySheets),
  ...handlersFor("Show", callSheets),
  // A department's call on a cue (1180, A54-002); the cue fixes its organization, one per department.
  ...handlersFor("Show", tableResource("cueCalls")),

  "cues.fire": async ({ params }, context) => {
    await cues.read(context, params.id, ["id"]);
    unwrap(await callCue(context.db, params.id));
    return ok((await cues.read(context, params.id)) as never);
  },

  "daySheets.publish": async ({ params }, context) => {
    await daySheets.read(context, params.id, ["id"]);
    unwrap(await publishSheet(context.db, "day_sheets", params.id));
    return ok((await daySheets.read(context, params.id)) as never);
  },

  "callSheets.publish": async ({ params }, context) => {
    await callSheets.read(context, params.id, ["id"]);
    unwrap(await publishSheet(context.db, "call_sheets", params.id));
    return ok((await callSheets.read(context, params.id)) as never);
  },
});
