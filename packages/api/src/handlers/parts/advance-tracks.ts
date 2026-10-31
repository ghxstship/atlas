/**
 * Advance tracks (R11, migration 2743; parity gap G-176). A section's track is a grouping label set through the same
 * @xos/data function Atlas uses; a reviewer signs off a recipient's track and revokes a sign-off only through the
 * RPCs, whose refusals come back as 422 with the rule. Track progress is computed in app.advance_track_progress and
 * read as the caller, so row level security decides.
 */
import { revokeTrackSignoff, setSectionTrack, signOffTrack } from "@xos/data/advancing";
import { versionFromIfMatch } from "../../runtime/etag.ts";
import type { HandlerSet } from "../../runtime/handler.ts";
import { created, ok } from "../../runtime/handler.ts";
import { handlersFor, tableResource, unwrap } from "../support/table.ts";

const sections = tableResource("advanceSections");
const recipients = tableResource("advanceRecipients");
const signoffs = tableResource("advanceTrackSignoffs", { softDelete: false });
const progress = tableResource("advanceTrackProgress", { softDelete: false, key: "track" });

export const advanceTrackHandlers = {
  ...handlersFor("Advancing", signoffs),
  ...handlersFor("Advancing", progress),

  "advanceSections.setTrack": async ({ params, body, ifMatch }, context) => {
    await sections.read(context, params.id, ["id"]);
    const version = versionFromIfMatch(ifMatch ?? "*");
    unwrap(await setSectionTrack(context.db, params.id, body.track, version));
    return ok((await sections.read(context, params.id)) as never);
  },

  "advanceRecipients.signOffTrack": async ({ params, body }, context) => {
    await recipients.read(context, params.id, ["id"]);
    const signoff = unwrap(await signOffTrack(context.db, params.id, body.track));
    return created((await signoffs.read(context, signoff.id)) as never);
  },

  "advanceTrackSignoffs.revoke": async ({ params, body }, context) => {
    await signoffs.read(context, params.id, ["id"]);
    unwrap(await revokeTrackSignoff(context.db, params.id, body.reason));
    return ok((await signoffs.read(context, params.id)) as never);
  },
} satisfies HandlerSet<"Advancing">;
