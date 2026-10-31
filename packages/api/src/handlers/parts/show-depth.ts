/**
 * Run-of-show depth handlers (B3, ADR 0142, migrations 2920 to 2923): the segment library, its cues and calls, the
 * copies of a segment in running orders, and showcaller links. Every call runs as the caller: row level security
 * decides what is read and written, and the definer RPCs decide who may insert or publish a segment and make or
 * manage a link. A showcaller link's token and access code are answered once, by create and regenerate; reads
 * never carry them.
 */
import type { Components } from "../../contract/operations.generated.ts";
import type { HandlerSet } from "../../runtime/handler.ts";
import { created, ok } from "../../runtime/handler.ts";
import { handlersFor, rpc, run, tableResource } from "../support/table.ts";

const segments = tableResource("segmentLibrary");
const showcallerLinks = tableResource("showcallerLinks", { verbs: ["list", "get"] });

type Made = { showcaller_link_id: string; token: string; access_code: string; expires_at: string };

export const showDepthHandlers: HandlerSet<"Show"> = {
  ...(handlersFor("Show", segments) as unknown as HandlerSet<"Show">),
  ...(handlersFor("Show", tableResource("segmentLibraryCues")) as unknown as HandlerSet<"Show">),
  ...(handlersFor(
    "Show",
    tableResource("segmentLibraryCueCalls"),
  ) as unknown as HandlerSet<"Show">),
  ...(handlersFor(
    "Show",
    tableResource("runSegmentInstances", { verbs: ["list", "get"] }),
  ) as unknown as HandlerSet<"Show">),
  ...(handlersFor("Show", showcallerLinks) as unknown as HandlerSet<"Show">),

  "segmentLibrary.insertIntoRun": async ({ params, body }, context) => {
    await segments.read(context, String(params.id), ["id"]);
    const instance = await run<string>(
      rpc(context.db, "insert_library_segment", {
        p_run_of_show_id: body.run_of_show_id,
        p_segment_library_id: params.id,
        ...((body.before_position ?? null) === null
          ? {}
          : { p_before_position: body.before_position }),
        ...((body.starts_at ?? null) === null ? {} : { p_starts_at: body.starts_at }),
      }),
    );
    return created({ segment_instance_id: instance } as Components["SegmentInsertResult"]);
  },
  "segmentLibrary.publish": async ({ params, body }, context) => {
    await segments.read(context, String(params.id), ["id"]);
    const rows = await run<Components["SegmentPublishResults"]["data"]>(
      rpc(context.db, "publish_library_segment", {
        p_segment_library_id: params.id,
        p_run_ids: body.run_of_show_ids,
      }),
    );
    return ok({ data: rows ?? [] } as Components["SegmentPublishResults"]);
  },

  "showcallerLinks.create": async ({ body }, context) => {
    const rows = await run<Made[]>(
      rpc(context.db, "create_showcaller_link", {
        p_run_of_show_id: body.run_of_show_id,
        p_caller_name: body.caller_name,
        ...((body.expires_at ?? null) === null ? {} : { p_expires_at: body.expires_at }),
        ...((body.note ?? null) === null ? {} : { p_note: body.note }),
      }),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("create_showcaller_link returned no row.");
    return created(row as Components["ShowcallerLinkToken"]);
  },
  "showcallerLinks.regenerate": async ({ params }, context) => {
    await showcallerLinks.read(context, String(params.id), ["id"]);
    const rows = await run<Omit<Made, "showcaller_link_id">[]>(
      rpc(context.db, "regenerate_showcaller_link", { p_showcaller_link_id: params.id }),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("regenerate_showcaller_link returned no row.");
    return ok(row as Components["ShowcallerLinkRegenerated"]);
  },
  "showcallerLinks.revoke": async ({ params }, context) => {
    await showcallerLinks.read(context, String(params.id), ["id"]);
    await run(rpc(context.db, "revoke_showcaller_link", { p_showcaller_link_id: params.id }));
    return ok(
      (await showcallerLinks.read(context, String(params.id))) as Components["ShowcallerLink"],
    );
  },
  "showcallerLinks.signOutDevices": async ({ params }, context) => {
    await showcallerLinks.read(context, String(params.id), ["id"]);
    const devices = await run<number>(
      rpc(context.db, "sign_out_showcaller_devices", { p_showcaller_link_id: params.id }),
    );
    return ok({ devices: Number(devices) } as Components["ShowcallerDevicesSignedOut"]);
  },
};
