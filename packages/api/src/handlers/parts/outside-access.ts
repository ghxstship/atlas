/**
 * Outside access handlers (B2, ADR 0141, migrations 6500 to 6507). Every call runs as the caller: each
 * table's policy decides what it reads, and the RPCs decide who may make, change or revoke. Tokens and
 * access codes are answered once, by the create, add, regenerate and resetCode actions; reads never carry
 * them. A file item is inserted by the caller, so the attachment's own read policy decides.
 */
import type { Components } from "../../contract/operations.generated.ts";
import type { HandlerSet } from "../../runtime/handler.ts";
import { created, ok } from "../../runtime/handler.ts";
import type { ListQuery } from "../../runtime/listing.ts";
import { badRequest } from "../../problem.ts";
import { rpc, run, tableResource } from "../support/table.ts";

const packs = tableResource("stakeholderPacks", { verbs: ["list", "get"] });
const items = tableResource("stakeholderPackItems", { verbs: ["list"] });
const recipients = tableResource("stakeholderPackRecipients", { verbs: ["list", "get"] });
const events = tableResource("stakeholderPackEvents", { verbs: ["list"] });
const intakeLinks = tableResource("vendorIntakeLinks", { verbs: ["list", "get"] });
const intakeRequests = tableResource("vendorIntakeRequests", { verbs: ["list", "get"] });
const formLinks = tableResource("formLinks", { verbs: ["list", "get"] });
const formResponses = tableResource("formLinkResponses", {
  verbs: ["list", "get"],
  scope: (q) => q.not("form_link_id", "is", null),
});
const outside = tableResource("outsideAccess", { verbs: ["list"], key: "source_id" });

const SET = <T>(value: T | null | undefined, name: string) =>
  (value ?? null) === null ? {} : { [name]: value };

const first = <T>(rows: T[], fn: string): T => {
  const row = rows[0];
  if (row === undefined) throw new Error(`${fn} returned no row.`);
  return row;
};

export const outsideAccessHandlers: HandlerSet<"Platform"> = {
  ...(packs.handlers as unknown as HandlerSet<"Platform">),
  ...(items.handlers as unknown as HandlerSet<"Platform">),
  ...(recipients.handlers as unknown as HandlerSet<"Platform">),
  ...(events.handlers as unknown as HandlerSet<"Platform">),
  ...(intakeLinks.handlers as unknown as HandlerSet<"Platform">),
  ...(intakeRequests.handlers as unknown as HandlerSet<"Platform">),
  ...(formLinks.handlers as unknown as HandlerSet<"Platform">),
  ...(formResponses.handlers as unknown as HandlerSet<"Platform">),

  // A file link's project is looked up per row (6507), so this view is never read unfiltered.
  "outsideAccess.list": async (request, context) => {
    const query = request.query as ListQuery;
    if (query.filter?.["project_id"]?.eq === undefined) {
      throw badRequest("filter[project_id][eq] is required: outside access is listed per project.");
    }
    return ok((await outside.list(context, query)) as never);
  },

  "stakeholderPacks.create": async ({ body }, context) => {
    const id = await run<string>(
      rpc(context.db, "create_stakeholder_pack", {
        p_project_id: body.project_id,
        p_name: body.name,
        p_expires_at: body.expires_at,
        ...SET(body.message, "p_message"),
        ...SET(body.note, "p_note"),
      }),
    );
    return created((await packs.read(context, id)) as Components["StakeholderPack"]);
  },
  "stakeholderPacks.update": async ({ params, body }, context) => {
    await packs.read(context, String(params.id), ["id"]);
    await run(
      rpc(context.db, "update_stakeholder_pack", {
        p_pack_id: params.id,
        p_name: body.name,
        p_message: body.message ?? "",
        p_note: body.note ?? "",
        p_expires_at: body.expires_at,
      }),
    );
    return ok((await packs.read(context, String(params.id))) as Components["StakeholderPack"]);
  },
  "stakeholderPacks.revoke": async ({ params }, context) => {
    await packs.read(context, String(params.id), ["id"]);
    await run(rpc(context.db, "revoke_stakeholder_pack", { p_pack_id: params.id }));
    return ok((await packs.read(context, String(params.id))) as Components["StakeholderPack"]);
  },
  "stakeholderPacks.setSchedule": async ({ params, body }, context) => {
    await packs.read(context, String(params.id), ["id"]);
    await run(
      rpc(context.db, "set_stakeholder_pack_schedule", {
        p_pack_id: params.id,
        p_cadence: body.cadence,
        p_local_hour: body.local_hour,
        ...SET(body.weekday, "p_weekday"),
        ...SET(body.month_day, "p_month_day"),
        ...SET(body.time_zone, "p_time_zone"),
      }),
    );
    const rows = await run<Components["StakeholderPackSchedule"][]>(
      context.db
        .from("stakeholder_pack_schedules")
        .select(
          "id, stakeholder_pack_id, cadence, local_hour, weekday, month_day, time_zone, next_run_at, paused_at",
        )
        .eq("stakeholder_pack_id", String(params.id))
        .is("deleted_at", null),
    );
    return ok(first(rows, "stakeholder_pack_schedules"));
  },
  "stakeholderPacks.clearSchedule": async ({ params }, context) => {
    await packs.read(context, String(params.id), ["id"]);
    await run(rpc(context.db, "clear_stakeholder_pack_schedule", { p_pack_id: params.id }));
    return ok((await packs.read(context, String(params.id))) as Components["StakeholderPack"]);
  },

  "stakeholderPackItems.add": async ({ body }, context) => {
    const id = await run<string>(
      rpc(context.db, "add_stakeholder_pack_item", {
        p_pack_id: body.stakeholder_pack_id,
        ...SET(body.live_link_id, "p_live_link_id"),
        ...SET(body.attachment_id, "p_attachment_id"),
        p_title: body.title,
        p_requires_acknowledgement: body.requires_acknowledgement ?? false,
      }),
    );
    return created((await items.read(context, id)) as Components["StakeholderPackItem"]);
  },
  "stakeholderPackItems.remove": async ({ params }, context) => {
    await run(rpc(context.db, "remove_stakeholder_pack_item", { p_item_id: params.id }));
    return ok({ id: String(params.id) } as Components["StakeholderPackItemRemoved"]);
  },

  "stakeholderPackRecipients.add": async ({ body }, context) => {
    const rows = await run<{ recipient_id: string; access_code: string }[]>(
      rpc(context.db, "add_stakeholder_pack_recipient", {
        p_pack_id: body.stakeholder_pack_id,
        p_full_name: body.full_name,
        p_email: body.email,
        ...SET(body.counterparty_id, "p_counterparty_id"),
        ...SET(body.label, "p_label"),
      }),
    );
    return created(
      first(rows, "add_stakeholder_pack_recipient") as Components["StakeholderPackRecipientCode"],
    );
  },
  "stakeholderPackRecipients.resetCode": async ({ params }, context) => {
    await recipients.read(context, String(params.id), ["id"]);
    const code = await run<string>(
      rpc(context.db, "reset_stakeholder_pack_recipient_code", { p_recipient_id: params.id }),
    );
    return ok({ access_code: code } as Components["StakeholderPackRecipientCodeReset"]);
  },
  "stakeholderPackRecipients.revoke": async ({ params }, context) => {
    await recipients.read(context, String(params.id), ["id"]);
    await run(rpc(context.db, "revoke_stakeholder_pack_recipient", { p_recipient_id: params.id }));
    return ok(
      (await recipients.read(context, String(params.id))) as Components["StakeholderPackRecipient"],
    );
  },
  "stakeholderPackRecipients.send": async ({ body }, context) => {
    const queued = await run<number>(
      rpc(context.db, "send_stakeholder_pack", {
        p_pack_id: body.stakeholder_pack_id,
        ...SET(body.recipient_ids, "p_recipient_ids"),
      }),
    );
    return ok({ queued } as Components["StakeholderPackSent"]);
  },

  "vendorIntakeLinks.create": async ({ body }, context) => {
    const rows = await run<Components["VendorIntakeLinkToken"][]>(
      rpc(context.db, "create_vendor_intake_link", {
        p_project_id: body.project_id,
        p_title: body.title,
        p_role_type: body.role_type,
        p_role_code: body.role_code,
        p_worker_classification: body.worker_classification,
        p_pay_basis: body.pay_basis,
        p_arrangement: body.arrangement,
        p_start_date: body.start_date,
        p_expires_at: body.expires_at,
        ...SET(body.end_date, "p_end_date"),
        ...SET(body.counterparty_type, "p_counterparty_type"),
        ...SET(body.agreement_document_id, "p_agreement_document_id"),
        ...SET(body.instructions, "p_instructions"),
        ...SET(body.note, "p_note"),
        ...SET(body.collect_tax_form, "p_collect_tax_form"),
        ...SET(body.collect_payout, "p_collect_payout"),
        ...SET(body.collect_invoice, "p_collect_invoice"),
        ...SET(body.max_requests, "p_max_requests"),
      }),
    );
    return created(first(rows, "create_vendor_intake_link"));
  },
  "vendorIntakeLinks.regenerate": async ({ params }, context) => {
    await intakeLinks.read(context, String(params.id), ["id"]);
    const rows = await run<Components["VendorIntakeLinkRegenerated"][]>(
      rpc(context.db, "regenerate_vendor_intake_link", { p_id: params.id }),
    );
    return ok(first(rows, "regenerate_vendor_intake_link"));
  },
  "vendorIntakeLinks.revoke": async ({ params }, context) => {
    await intakeLinks.read(context, String(params.id), ["id"]);
    await run(rpc(context.db, "revoke_vendor_intake_link", { p_id: params.id }));
    return ok(
      (await intakeLinks.read(context, String(params.id))) as Components["VendorIntakeLink"],
    );
  },

  "vendorIntakeRequests.approve": async ({ params, body }, context) => {
    await intakeRequests.read(context, String(params.id), ["id"]);
    await run(
      rpc(context.db, "decide_vendor_intake", {
        p_request_id: params.id,
        p_approve: true,
        ...SET(body.reason, "p_reason"),
      }),
    );
    return ok(
      (await intakeRequests.read(context, String(params.id))) as Components["VendorIntakeRequest"],
    );
  },
  "vendorIntakeRequests.decline": async ({ params, body }, context) => {
    await intakeRequests.read(context, String(params.id), ["id"]);
    await run(
      rpc(context.db, "decide_vendor_intake", {
        p_request_id: params.id,
        p_approve: false,
        p_reason: body.reason,
      }),
    );
    return ok(
      (await intakeRequests.read(context, String(params.id))) as Components["VendorIntakeRequest"],
    );
  },

  "formLinks.create": async ({ body }, context) => {
    const rows = await run<Components["FormLinkToken"][]>(
      rpc(context.db, "create_form_link", {
        p_template_id: body.form_template_id,
        p_expires_at: body.expires_at,
        ...SET(body.project_id, "p_project_id"),
        ...SET(body.daily_cap, "p_daily_cap"),
        ...SET(body.max_responses, "p_max_responses"),
        ...SET(body.one_per_email, "p_one_per_email"),
        ...SET(body.note, "p_note"),
      }),
    );
    return created(first(rows, "create_form_link"));
  },
  "formLinks.regenerate": async ({ params }, context) => {
    await formLinks.read(context, String(params.id), ["id"]);
    const rows = await run<Components["FormLinkRegenerated"][]>(
      rpc(context.db, "regenerate_form_link", { p_id: params.id }),
    );
    return ok(first(rows, "regenerate_form_link"));
  },
  "formLinks.revoke": async ({ params }, context) => {
    await formLinks.read(context, String(params.id), ["id"]);
    await run(rpc(context.db, "revoke_form_link", { p_id: params.id }));
    return ok((await formLinks.read(context, String(params.id))) as Components["FormLink"]);
  },

  "formLinkResponses.decide": async ({ params, body }, context) => {
    await formResponses.read(context, String(params.id), ["id"]);
    await run(
      rpc(context.db, "decide_form_submission", {
        p_submission_id: params.id,
        p_approve: body.approve,
        ...SET(body.note, "p_note"),
      }),
    );
    return ok(
      (await formResponses.read(context, String(params.id))) as Components["FormLinkResponse"],
    );
  },
};
