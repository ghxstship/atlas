/**
 * A36 handlers (migrations 1060 to 1064): support sessions and wholesale statements of the partner
 * console, acting on a notification where it arrives (the server half of approving from a push
 * notification), and the import dry run and commit request. handlers/platform.ts spreads them. Every
 * call runs as the caller: row level security and the RPCs decide, and refusals answer 422 with the
 * rule. Shapes follow catalog/modules/parts/a36.ts.
 */
import { requireOrg } from "../../runtime/context.ts";
import type { ErasedHandler } from "../../runtime/handler.ts";
import { created, ok } from "../../runtime/handler.ts";
import { rpc, run, tableResource, type Row } from "../support/table.ts";

const supportSessions = tableResource("supportSessions", { verbs: ["list", "get"] });
const wholesaleStatements = tableResource("wholesaleStatements", { verbs: ["list", "get"] });
const notifications = tableResource("notifications");
const importJobs = tableResource("importJobs", { verbs: ["list", "get", "create"] });

export const a36Handlers: Readonly<Record<string, ErasedHandler>> = {
  ...supportSessions.handlers,
  "supportSessions.grant": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const id = await run<string>(
      rpc(context.db, "grant_support_session", {
        p_org_id: requireOrg(context).id,
        p_hours: body["hours"],
        p_reason: body["reason"],
      }),
    );
    return created(await supportSessions.read(context, id));
  },
  "supportSessions.end": async (request, context) => {
    const id = String(request.params["id"]);
    await supportSessions.read(context, id, ["id"]);
    await run(rpc(context.db, "end_support_session", { p_support_session_id: id }));
    return ok(await supportSessions.read(context, id));
  },

  ...wholesaleStatements.handlers,
  "wholesaleStatements.run": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const id = await run<string>(
      rpc(context.db, "run_wholesale_billing", {
        p_partner_org_id: requireOrg(context).id,
        p_period_start: body["period_start"],
      }),
    );
    return created(await wholesaleStatements.read(context, id));
  },

  "notifications.act": async (request, context) => {
    const id = String(request.params["id"]);
    const body = (request.body ?? {}) as Row;
    await notifications.read(context, id, ["id"]);
    await run(
      rpc(context.db, "act_on_notification", {
        p_notification_id: id,
        p_action: body["action"],
        p_comment: body["comment"] ?? null,
      }),
    );
    return ok(await notifications.read(context, id));
  },

  "importJobs.dryRun": async (request, context) => {
    const id = String(request.params["id"]);
    await importJobs.read(context, id, ["id"]);
    const rows = await run<Row[]>(rpc(context.db, "import_dry_run", { p_import_job_id: id }));
    const counts = rows[0] ?? {};
    return ok({
      creates: Number(counts["creates"] ?? 0),
      updates: Number(counts["updates"] ?? 0),
      merges: Number(counts["merges"] ?? 0),
      refusals: Number(counts["refusals"] ?? 0),
      skipped: Number(counts["skipped"] ?? 0),
      pending_reviews: Number(counts["pending_reviews"] ?? 0),
    });
  },
  "importJobs.commit": async (request, context) => {
    const id = String(request.params["id"]);
    await importJobs.read(context, id, ["id"]);
    await run(rpc(context.db, "request_import_commit", { p_import_job_id: id }));
    return created(await importJobs.read(context, id));
  },
};
