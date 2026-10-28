/**
 * Live link handlers (P1, ADR 0130, migrations 2780 to 2782): list, get, createView, createDisplay,
 * regenerate and revoke. Every call runs as the caller: the live link policy shows links of projects
 * where the caller holds the collection's read capability, and the RPCs decide who may make,
 * regenerate or revoke a link. The token and the access code are answered once, by the create and
 * regenerate actions; reads never carry them.
 */
import type { Components } from "../../contract/operations.generated.ts";
import type { HandlerSet } from "../../runtime/handler.ts";
import { created, ok } from "../../runtime/handler.ts";
import { rpc, run, tableResource } from "../support/table.ts";

const liveLinks = tableResource("liveLinks", { verbs: ["list", "get"] });

type Made = { live_link_id: string; token: string; access_code: string; expires_at: string };

/** The note, when one was given; the RPCs default it to none. */
const noteArg = (note: string | null | undefined) =>
  (note ?? null) === null ? {} : { p_note: note };

export const liveLinkHandlers: HandlerSet<"Platform"> = {
  ...(liveLinks.handlers as unknown as HandlerSet<"Platform">),
  "liveLinks.createView": async ({ body }, context) => {
    const rows = await run<Made[]>(
      rpc(context.db, "create_view_link", {
        p_saved_view_id: body.saved_view_id,
        p_project_id: body.project_id,
        p_expires_at: body.expires_at,
        ...noteArg(body.note),
      }),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("create_view_link returned no row.");
    return created(row as Components["LiveViewLinkToken"]);
  },
  "liveLinks.createDisplay": async ({ body }, context) => {
    const rows = await run<Made[]>(
      rpc(context.db, "create_display_link", {
        p_run_of_show_id: body.run_of_show_id,
        ...((body.expires_at ?? null) === null ? {} : { p_expires_at: body.expires_at }),
        ...((body.default_mode ?? null) === null ? {} : { p_default_mode: body.default_mode }),
        ...noteArg(body.note),
      }),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("create_display_link returned no row.");
    return created(row as Components["LiveDisplayLinkToken"]);
  },
  "liveLinks.regenerate": async ({ params }, context) => {
    await liveLinks.read(context, String(params.id), ["id"]);
    const rows = await run<Omit<Made, "live_link_id">[]>(
      rpc(context.db, "regenerate_live_link", { p_live_link_id: params.id }),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("regenerate_live_link returned no row.");
    return ok(row as Components["LiveLinkRegenerated"]);
  },
  "liveLinks.revoke": async ({ params }, context) => {
    await liveLinks.read(context, String(params.id), ["id"]);
    await run(rpc(context.db, "revoke_live_link", { p_live_link_id: params.id }));
    return ok((await liveLinks.read(context, String(params.id))) as Components["LiveLink"]);
  },
};
