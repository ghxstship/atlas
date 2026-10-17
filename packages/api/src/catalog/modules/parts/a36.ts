/**
 * A36 journey surfaces (migrations 1060 to 1064): support sessions and wholesale statements of the
 * partner console (Section 4.6.1), acting on a notification where it arrives (the server half of
 * approving from a push notification, Section 11.10 rule 5), and the import dry run counts (Section
 * 4.6.2 step 6). catalog/modules/platform.ts spreads them into the Platform additions.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { editDefinition, putActions } from "../../correct.ts";
import type { CorrectionInput } from "../../corrections.ts";
import { collectionAction, itemAction, resource } from "../../define.ts";
import type { ActionSpec, ResourceSpec } from "../../types.ts";

const SINCE = "1.0.0-draft.2";

/** Audit people are nullable on every resource (ADR 0023): seed and platform rows carry none. */
const audited = (def: Parameters<typeof editDefinition>[0]) =>
  editDefinition(def, { nullable: ["created_by", "updated_by"] });

const SupportSession = audited(
  defineResource({
    name: "SupportSession",
    table: "app.support_sessions",
    description:
      "A support session (1060): the client org's Owner lets its partner's staff read the client org for 1 to 24 hours. Partner staff read nothing of a client without one; they never write. Created with supportSessions.grant and ended early with supportSessions.end.",
    fields: {
      grantee_org_id: fields.ref("partner org whose staff may read while the session lasts"),
      reason: fields.text("Why the session was granted.", "Help with the venue import.", 500),
      starts_at: fields.instant("When access began."),
      ends_at: fields.instant("When access ends on its own, at most 24 hours after it began."),
      ended_at: fields.instant("When someone ended the session early.").nullable(),
      ended_by: fields.ref("person who ended it early").nullable(),
    },
    serverSet: ["grantee_org_id", "starts_at", "ends_at", "ended_at", "ended_by"],
  }),
);

const WholesaleStatement = audited(
  defineResource({
    name: "WholesaleStatement",
    table: "app.wholesale_statements",
    description:
      "What the platform bills a partner for one month (1060): each client org at its plan's list price less the wholesale discount. Totals cover priced lines; unpriced lines are counted, never zero. Append-only.",
    fields: {
      period_start: fields.date("First day of the month billed."),
      currency_code: fields.currency("Currency of the partner agreement."),
      wholesale_discount_bps: fields.int(
        "Discount in basis points when the statement ran.",
        2000,
        0,
      ),
      client_count: fields.int("Client orgs on the statement.", 3, 0),
      list_total_minor: fields
        .int(
          "Sum of priced list prices in minor units; null only while a statement has no priced line.",
          14700,
          0,
        )
        .nullable(),
      wholesale_total_minor: fields
        .int(
          "What the partner owes, in minor units; null only while a statement has no priced line.",
          11760,
          0,
        )
        .nullable(),
      unpriced_count: fields.int("Lines whose plan is unpriced in the currency.", 0, 0),
    },
    serverSet: [
      "period_start",
      "currency_code",
      "wholesale_discount_bps",
      "client_count",
      "list_total_minor",
      "wholesale_total_minor",
      "unpriced_count",
    ],
  }),
);

const ImportDryRun = z
  .object({
    creates: fields.int("Rows that will create a record.", 12, 0),
    updates: fields.int("Rows that will update the record their strong key matched.", 3, 0),
    merges: fields.int("Rows that will merge into a record a person chose.", 1, 0),
    refusals: fields.int("Rows that are Invalid or Refused.", 2, 0),
    skipped: fields.int("Rows skipped.", 0, 0),
    pending_reviews: fields.int("Possible duplicates still waiting for a person.", 0, 0),
  })
  .meta({
    id: "ImportDryRun",
    description: "What committing an import would write (Section 4.6.2 step 6).",
  });

export const a36Resources: readonly ResourceSpec[] = [
  resource("Platform", "/support-sessions", SupportSession, {
    verbs: ["list", "get"],
    actions: [
      collectionAction("grant", {
        summary: "Grant the partner a support session",
        description:
          "The client org's Owner (org.support_session.grant) lets its partner's staff read the client org for 1 to 24 hours with a reason (app.grant_support_session). One open session at a time (support_session_active: 422); an org without a partner refuses (support_session_no_partner: 422).",
        body: z
          .object({
            hours: fields.int("Length of the session in hours, 1 to 24.", 4, 1),
            reason: fields.text(
              "Why the partner needs access.",
              "Help with the venue import.",
              500,
            ),
          })
          .meta({ id: "SupportSessionGrantRequest", description: "A support session to grant." }),
        rpc: "grant_support_session",
        status: 201,
      }),
      itemAction("end", {
        summary: "End a support session early",
        description:
          "Ends an open session at once (app.end_support_session): the client's Owner or the partner's staff with org.partner.manage. An ended session answers 422 (support_session_ended).",
        rpc: "end_support_session",
      }),
    ],
  }),
  resource("Platform", "/wholesale-statements", WholesaleStatement, {
    verbs: ["list", "get"],
    order: { by: ["period_start"], numeric: false, descending: true },
    actions: [
      collectionAction("run", {
        summary: "Run wholesale billing for a month",
        description:
          "Records the partner's statement for a month (app.run_wholesale_billing, org.billing.manage): every client org at its plan's list price less the agreed discount. A month is billed once (wholesale_statement_exists: 422); a partner without an agreement refuses (partner_agreement_missing: 422).",
        body: z
          .object({ period_start: fields.date("First day of the month to bill.") })
          .meta({ id: "WholesaleBillingRequest", description: "The month to bill." }),
        rpc: "run_wholesale_billing",
        status: 201,
      }),
    ],
  }),
];

export const a36Actions: Readonly<Record<string, readonly ActionSpec[]>> = {
  notifications: [
    itemAction("act", {
      summary: "Act on a notification",
      description:
        "Acts where the notification arrived, without opening its record (app.act_on_notification): approve or reject the approval an approval request asks for (app.decide_approval decides every rule; a rejection needs a comment), or mark it Done. Only the recipient acts. Push notification action buttons call this operation.",
      body: z
        .object({
          action: z
            .enum(["approve", "reject", "done"])
            .meta({ description: "What to do.", example: "approve" }),
          comment: fields
            .longText("Reason, required when rejecting.", "Over the stage budget.")
            .optional(),
        })
        .meta({ id: "NotificationActRequest", description: "An action on a notification." }),
      rpc: "act_on_notification",
    }),
  ],
};

export const a36Capabilities: Readonly<Record<string, CapabilityRule>> = {
  supportSessions: {
    read: "org.settings.read",
    actions: { grant: "org.support_session.grant", end: "org.support_session.grant" },
  },
  wholesaleStatements: { read: "org.billing.manage", actions: { run: "org.billing.manage" } },
  notifications: { actions: { act: "inbox.notifications.write" } },
};

export const a36Corrections: readonly CorrectionInput[] = [
  {
    id: "import-job-dry-run-counts",
    since: SINCE,
    resources: ["importJobs"],
    components: ["schemas/ImportDryRun"],
    change:
      "`importJobs.dryRun` answers the dry run counts (ImportDryRun) instead of the import job.",
    reason:
      "app.import_dry_run (1061) counts creates, updates, merges, refusals, skipped rows and pending reviews from the validated rows; the import job carries none of them.",
    apply: putActions([
      itemAction("dryRun", {
        summary: "Dry-run an import",
        description:
          "Counts what committing a validated import would write (app.import_dry_run): creates, strong key updates, merges a person chose, refusals and possible duplicates still pending.",
        response: ImportDryRun,
        rpc: "import_dry_run",
      }),
    ]),
  },
];
