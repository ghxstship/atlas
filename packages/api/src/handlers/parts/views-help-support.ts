/**
 * Views, help and support handlers (A31, migrations 0641 to 0643): saved view team shares and
 * per-page defaults, tour progress, tip dismissals, and support requests with their messages and
 * diagnostics. handlers/platform.ts spreads them. Every call runs as the caller: row level security
 * and the RPCs decide, and refusals come back as 422 with the rule.
 */
import { refused } from "../../problem.ts";
import type { RequestContext } from "../../runtime/context.ts";
import { requireOrg } from "../../runtime/context.ts";
import { created, ok } from "../../runtime/handler.ts";
import type { ErasedHandler } from "../../runtime/handler.ts";
import { from, rpc, run, tableResource, type Row } from "../support/table.ts";

/** The caller's active membership in the credential's organization. */
async function myMembership(context: RequestContext): Promise<string> {
  const org = requireOrg(context);
  if (context.personId === null) {
    throw refused("REFUSE", "Only a signed-in member has preferences and requests.", "no_person");
  }
  const rows = await run<{ id: string }[]>(
    from(context.db, "memberships")
      .select("id")
      .eq("org_id", org.id)
      .eq("person_id", context.personId)
      .is("deleted_at", null)
      .order("valid_from", { ascending: false })
      .limit(1),
  );
  const row = rows[0];
  if (row === undefined) {
    throw refused("REFUSE", "Only a member of the organization can do this.", "not_member");
  }
  return row.id;
}

const ownMembership = async (_body: Row, context: RequestContext): Promise<Row> => ({
  membership_id: await myMembership(context),
});

const savedViewShares = tableResource("savedViewShares", { orgColumn: false });
const savedViewDefaults = tableResource("savedViewDefaults", { orgColumn: false });
const tourProgress = tableResource("tourProgress", {
  orgColumn: false,
  beforeCreate: ownMembership,
});
const tipDismissals = tableResource("tipDismissals", {
  orgColumn: false,
  beforeCreate: ownMembership,
});
const supportTickets = tableResource("supportTickets");
const supportTicketMessages = tableResource("supportTicketMessages", { softDelete: false });
const supportTicketDiagnostics = tableResource("supportTicketDiagnostics", { softDelete: false });

export const viewsHelpSupportHandlers: Readonly<Record<string, ErasedHandler>> = {
  ...savedViewShares.handlers,
  ...savedViewDefaults.handlers,
  // Choosing a default replaces the page's earlier one in one statement.
  "savedViewDefaults.create": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const id = await run<string>(
      rpc(context.db, "set_saved_view_default", { p_saved_view_id: body["saved_view_id"] }),
    );
    return created(await savedViewDefaults.read(context, id));
  },
  ...tourProgress.handlers,
  ...tipDismissals.handlers,
  ...supportTickets.handlers,
  "supportTickets.open": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const id = await run<string>(
      rpc(context.db, "open_support_ticket", {
        p_org_id: requireOrg(context).id,
        p_queue: body["queue"],
        p_category: body["category"],
        p_subject: body["subject"],
        p_body: body["body"],
        ...(body["severity"] === undefined ? {} : { p_severity: body["severity"] }),
        ...(body["diagnostics"] === undefined ? {} : { p_diagnostics: body["diagnostics"] }),
      }),
    );
    return created(await supportTickets.read(context, id));
  },
  "supportTickets.transition": async (request, context) => {
    const id = String(request.params["id"]);
    const body = (request.body ?? {}) as Row;
    await supportTickets.read(context, id, ["id"]);
    await run(
      rpc(context.db, "transition_support_ticket", {
        p_support_ticket_id: id,
        p_expected: body["expected_state"],
        p_next: body["to_state"],
        p_reason: body["reason"] ?? "",
      }),
    );
    return ok(await supportTickets.read(context, id));
  },
  "supportTickets.reply": async (request, context) => {
    const id = String(request.params["id"]);
    const body = (request.body ?? {}) as Row;
    await supportTickets.read(context, id, ["id"]);
    const messageId = await run<string>(
      rpc(context.db, "post_support_message", { p_support_ticket_id: id, p_body: body["body"] }),
    );
    return created(await supportTicketMessages.read(context, messageId));
  },
  ...supportTicketMessages.handlers,
  ...supportTicketDiagnostics.handlers,
};
