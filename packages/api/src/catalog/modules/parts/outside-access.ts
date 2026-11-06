/**
 * Outside stakeholder access (B2, ADR 0141, migrations 2910 to 2917): stakeholder packs and their items,
 * recipients, schedules and events, reusable vendor intake links and requests, public form links and their
 * responses, and one list of everything that reaches a project from outside the org. Every link expires
 * within 90 days and has a 6-digit access code (Section 7.5 invariant 8, ADR 0033 decision 56); tokens and
 * codes are answered once and stored only as hashes. catalog/modules/platform.ts spreads these into the
 * Platform additions. The token RPCs are not API operations, as ADR 0130 documents, and neither are the
 * requester's own intake calls (app.submit_vendor_intake and the rest), which Gateway's server actions make.
 */
import { z } from "@hono/zod-openapi";
import { Constants } from "@xos/data/database.types";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { editDefinition, orNull } from "../../correct.ts";
import { collectionAction, itemAction, resource } from "../../define.ts";
import type { ResourceSpec } from "../../types.ts";

const accessCode = z
  .string()
  .regex(/^[0-9]{6}$/)
  .meta({
    description:
      "The 6-digit access code. Shown once; send it apart from the link, never by email.",
    example: "042424",
  });

const tokenField = (prefix: "xvin" | "xfrm", path: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[0-9a-f]{64}$`))
    .meta({
      description: `The link token; the address is \`${path}\`. Shown once; only its hash is stored.`,
      example: `${prefix}_${"0".repeat(64)}`,
    });

// Stakeholder packs ---------------------------------------------------------------------------------

const StakeholderPack = defineResource({
  name: "StakeholderPack",
  table: "app.stakeholder_packs",
  description:
    "A named bundle of a project's live links and Public or Internal files for people outside the org (ADR 0141). Members holding projects.settings.write on the project read and change packs; a partner org reaching the project through a project share sees none. Revoking a pack stops every link and device grant at once.",
  serverSet: ["revoked_at", "revoked_by"],
  immutable: ["project_id"],
  fields: {
    project_id: fields.ref("project the pack shares from"),
    name: fields.text("Pack name shown to recipients.", "Client pack", 120),
    message: orNull(
      fields.text(
        "Message shown to recipients at the top of the pack.",
        "Welcome to the show.",
        2000,
      ),
    ),
    note: orNull(
      fields.text(
        "What the pack is for, for the team. Never on a token page or in an email.",
        "For the client's finance team",
        200,
      ),
    ),
    expires_at: fields.instant("When the pack stops opening: after now and within 90 days."),
    revoked_at: orNull(fields.instant("When the pack was revoked; it never opens again.")),
    revoked_by: orNull(fields.ref("person who revoked the pack")),
  },
});

const PackItemKind = z.enum(Constants.app.Enums.pack_item_kind).meta({
  description:
    "Live Link, one P1 live link of the project; File, one Public or Internal file of the project.",
  example: "File",
});

const StakeholderPackItem = defineResource({
  name: "StakeholderPackItem",
  table: "app.stakeholder_pack_items",
  description:
    "One item of a stakeholder pack (ADR 0141), at most 30: a live link of the pack's project or a file of the project whose current version scanned clean and is Public or Internal. The file's own read policy decides whether the caller may add it.",
  serverSet: ["item_kind", "position"],
  immutable: ["stakeholder_pack_id", "live_link_id", "attachment_id"],
  fields: {
    stakeholder_pack_id: fields.ref("pack the item belongs to"),
    item_kind: PackItemKind,
    live_link_id: orNull(fields.ref("live link the item opens")),
    attachment_id: orNull(fields.ref("file the item downloads")),
    title: fields.text("Item title shown to recipients.", "Floor plan", 200),
    position: fields.int("Order in the pack, from 0.", 0),
    requires_acknowledgement: z.boolean().meta({
      description:
        "True when each recipient is asked to type their name to acknowledge the item: a receipt, not a signature of a contract.",
      example: false,
    }),
  },
});

// Written without a person (an open, a read or a link response), so the last updater can be nobody.
const StakeholderPackRecipient = editDefinition(
  defineResource({
    name: "StakeholderPackRecipient",
    table: "app.stakeholder_pack_recipients",
    description:
      "One person outside the org a stakeholder pack is for (ADR 0141), at most 200 per pack. The 6-digit access code is returned once by `stakeholderPackRecipients.add` and `stakeholderPackRecipients.resetCode` and stored only as a salted hash, so it never appears here.",
    serverSet: ["failed_attempts", "unsubscribed_at", "revoked_at", "revoked_by"],
    immutable: ["stakeholder_pack_id"],
    fields: {
      stakeholder_pack_id: fields.ref("pack the recipient may open"),
      full_name: fields.text("Recipient's name as the team entered it.", "Cleo Client", 200),
      email: fields.text("Where the pack's sign-in links go, lower case.", "cleo@example.com", 320),
      counterparty_id: orNull(fields.ref("supplier the recipient works for")),
      label: orNull(
        fields.text("Group the recipient belongs to, for example a department.", "Finance", 80),
      ),
      failed_attempts: fields.int(
        "Wrong access codes since the code was set; the recipient locks at 5.",
        0,
      ),
      unsubscribed_at: orNull(fields.instant("When the recipient stopped the pack's emails.")),
      revoked_at: orNull(fields.instant("When the recipient was revoked.")),
      revoked_by: orNull(fields.ref("person who revoked the recipient")),
    },
  }),
  { nullable: ["created_by", "updated_by"] },
);

const PackCadence = z.enum(Constants.app.Enums.schedule_cadence).meta({
  description: "How often a fresh sign-in link goes out.",
  example: "Weekly",
});

const StakeholderPackSchedule = z
  .object({
    id: fields.uuid("The schedule."),
    stakeholder_pack_id: fields.uuid("The pack."),
    cadence: PackCadence,
    local_hour: fields.int("Hour of the day it sends, 0 to 23, in time_zone.", 9),
    weekday: orNull(fields.int("Weekly only: day of the week, 1 (Monday) to 7.", 1)),
    month_day: orNull(fields.int("Monthly only: day of the month, 1 to 28.", 1)),
    time_zone: fields.text("IANA time zone the hour is in.", "America/New_York", 80),
    next_run_at: fields.instant("Next slot."),
    paused_at: orNull(
      fields.instant("When the scheduler ended the schedule at the pack's expiry."),
    ),
  })
  .meta({
    id: "StakeholderPackSchedule",
    description: "When a stakeholder pack emails its recipients a fresh sign-in link.",
  });

const PackEventAction = z
  .enum(Constants.app.Enums.pack_event_action)
  .meta({ description: "What happened.", example: "Opened" });

// Written without a person (an open, a read or a link response), so the last updater can be nobody.
const StakeholderPackEvent = editDefinition(
  defineResource({
    name: "StakeholderPackEvent",
    table: "app.stakeholder_pack_events",
    description:
      "What each stakeholder pack recipient did (ADR 0141), append-only. Written only by the pack RPCs; no visitor address is kept.",
    serverSet: [
      "stakeholder_pack_id",
      "recipient_id",
      "item_id",
      "action",
      "signer_name",
      "occurred_at",
    ],
    fields: {
      stakeholder_pack_id: fields.ref("pack the event belongs to"),
      recipient_id: fields.ref("recipient who acted"),
      item_id: orNull(fields.ref("item viewed, downloaded or signed")),
      action: PackEventAction,
      signer_name: orNull(
        fields.text("Name typed to acknowledge the item; Signed only.", "Cleo Client", 200),
      ),
      occurred_at: fields.instant("When it happened."),
    },
  }),
  { nullable: ["created_by", "updated_by"] },
);

// Vendor intake -------------------------------------------------------------------------------------

// Written without a person (an open, a read or a link response), so the last updater can be nobody.
const VendorIntakeLink = editDefinition(
  defineResource({
    name: "VendorIntakeLink",
    table: "app.vendor_intake_links",
    description:
      "A reusable vendor intake link (ADR 0141): one link and 6-digit access code a project gives to many vendors or contractors. Each signs in to Gateway and sends a request that, once approved, becomes an Onboarding engagement on these terms. The token and code are returned once by `vendorIntakeLinks.create` and `vendorIntakeLinks.regenerate` and stored only as hashes.",
    serverSet: ["token_hint", "failed_attempts", "rotated_at", "revoked_at", "revoked_by"],
    immutable: [
      "project_id",
      "role_type",
      "role_code",
      "worker_classification",
      "pay_basis",
      "arrangement",
      "agreement_document_id",
    ],
    fields: {
      project_id: fields.ref("project the engagements join"),
      role_type: z.enum(["Vendor", "Contractor"]).meta({
        description: "Vendor, a company account engages; Contractor, the signed-in person engages.",
        example: "Vendor",
      }),
      role_code: fields.text("Canon role the engagements take.", "9000.50.02", 40),
      worker_classification: fields.text(
        "Canon worker classification; never an employee one.",
        "VENDOR_SUPPLIED",
        60,
      ),
      pay_basis: orNull(fields.text("Canon pay basis.", "Day Rate", 60)),
      arrangement: orNull(fields.text("Canon arrangement.", "Per Engagement", 60)),
      counterparty_type: orNull(
        fields.text(
          "Canon counterparty type a new vendor gets; required for Vendor.",
          "AV Integrator",
          80,
        ),
      ),
      start_date: fields.date("First day of the engagements."),
      end_date: orNull(fields.date("Last day of the engagements, when known.")),
      agreement_document_id: orNull(fields.ref("Knowledge document each requester signs")),
      agreement_version_id: orNull(fields.ref("version pinned when the link was made")),
      title: fields.text("What the link is for, shown on the public page.", "Audio vendors", 120),
      instructions: orNull(
        fields.text("Instructions shown on the public page.", "Send us your details.", 2000),
      ),
      note: orNull(
        fields.text(
          "What the link is for, for the team. Never on the public page.",
          "Summer season",
          200,
        ),
      ),
      collect_tax_form: z
        .boolean()
        .meta({ description: "True when a request must carry a tax form.", example: true }),
      collect_payout: z
        .boolean()
        .meta({ description: "True when the intake asks for a payout reference.", example: true }),
      collect_invoice: z.boolean().meta({
        description: "True when a request may carry a first invoice draft.",
        example: false,
      }),
      token_hint: fields.text("Last four characters of the token, to tell links apart.", "3f9a", 4),
      expires_at: fields.instant(
        "When the link stops opening: within 90 days of when it was made.",
      ),
      max_requests: fields.int("Most requests the link takes, 1 to 500.", 50),
      failed_attempts: fields.int(
        "Wrong access codes since the link was made or regenerated; it locks at 5.",
        0,
      ),
      rotated_at: orNull(fields.instant("When the link was last regenerated.")),
      revoked_at: orNull(fields.instant("When the link was revoked; it never opens again.")),
      revoked_by: orNull(fields.ref("person who revoked the link")),
    },
  }),
  { nullable: ["created_by", "updated_by"] },
);

const IntakeLinkToken = z
  .object({
    vendor_intake_link_id: fields.uuid("The new link."),
    token: tokenField("xvin", "{Gateway origin}/onboard/{token}"),
    access_code: accessCode,
    expires_at: fields.instant("When the link stops opening."),
  })
  .meta({
    id: "VendorIntakeLinkToken",
    description: "A new intake link with its token and access code, shown once.",
  });

const IntakeLinkRegenerated = z
  .object({
    token: tokenField("xvin", "{Gateway origin}/onboard/{token}"),
    access_code: accessCode,
    expires_at: fields.instant("When the link stops opening; regenerating keeps the expiry."),
  })
  .meta({
    id: "VendorIntakeLinkRegenerated",
    description: "A regenerated intake link's new token and access code, shown once.",
  });

const VendorIntakeRequest = defineResource({
  name: "VendorIntakeRequest",
  table: "app.vendor_intake_requests",
  description:
    "What a vendor or contractor sent through a reusable intake link (ADR 0141). It holds references only: no tax identifier or bank number. Members holding opportunities.engagement.read on the project read it; the requester reads through Gateway. A request is written by Gateway's server actions and decided here.",
  serverSet: [
    "vendor_intake_link_id",
    "project_id",
    "requested_by",
    "account_id",
    "tax_form_id",
    "payout_account_id",
    "signer_name",
    "signed_at",
    "signed_version_id",
    "invoice_draft",
    "request_state",
    "decided_by",
    "decided_at",
    "decision_reason",
    "engagement_id",
    "invoice_id",
  ],
  fields: {
    vendor_intake_link_id: fields.ref("intake link the request came through"),
    project_id: fields.ref("project of the link"),
    requested_by: fields.ref("person who sent the request"),
    account_id: orNull(fields.ref("company account, for a Vendor link")),
    tax_form_id: orNull(fields.ref("the requester's own tax form")),
    payout_account_id: orNull(fields.ref("the requester's own payout reference")),
    signer_name: orNull(fields.text("Name typed to sign the agreement.", "Victor Osei", 200)),
    signed_at: orNull(fields.instant("When the requester signed.")),
    signed_version_id: orNull(fields.ref("agreement version signed")),
    invoice_draft: z.record(z.string(), z.unknown()).nullable().meta({
      description:
        "Optional first invoice: invoice_number, issue_date, due_date, currency_code and up to 50 lines.",
      example: null,
    }),
    request_state: z.enum(Constants.app.Enums.join_request_state).meta({
      description: "Pending, Approved, Declined or Withdrawn.",
      example: "Pending",
    }),
    decided_by: orNull(fields.ref("member who decided")),
    decided_at: orNull(fields.instant("When it was decided.")),
    decision_reason: orNull(
      fields.text(
        "Why it was declined, or a note on approval.",
        "We already have this crew booked.",
        1000,
      ),
    ),
    engagement_id: orNull(fields.ref("engagement the approval created")),
    invoice_id: orNull(fields.ref("invoice the draft became")),
  },
});

// Public form links ---------------------------------------------------------------------------------

// Written without a person (an open, a read or a link response), so the last updater can be nobody.
const FormLink = editDefinition(
  defineResource({
    name: "FormLink",
    table: "app.form_links",
    description:
      "A public link to a Published form with no photo, signature or GPS (ADR 0141): people outside the org open it with a 6-digit access code and answer without an account. Responses are filed Submitted and become project records only when approved. The token and code are returned once and stored only as hashes.",
    serverSet: ["token_hint", "failed_attempts", "rotated_at", "revoked_at", "revoked_by"],
    immutable: ["form_template_id", "project_id"],
    fields: {
      form_template_id: fields.ref("form the link answers"),
      project_id: orNull(fields.ref("project the responses belong to")),
      note: orNull(
        fields.text(
          "What the link is for, for the team. Never on the public page.",
          "Supplier check-in",
          200,
        ),
      ),
      token_hint: fields.text("Last four characters of the token, to tell links apart.", "3f9a", 4),
      expires_at: fields.instant(
        "When the link stops opening: within 90 days of when it was made.",
      ),
      daily_cap: fields.int("Most responses in any 24 hours, 1 to 1000.", 200),
      max_responses: z
        .number()
        .int()
        .nullable()
        .meta({ description: "Most responses in all, 1 to 10000, or none.", example: null }),
      one_per_email: z.boolean().meta({
        description: "True when each email address answers the link once.",
        example: true,
      }),
      failed_attempts: fields.int(
        "Wrong access codes since the link was made or regenerated; it locks at 5.",
        0,
      ),
      rotated_at: orNull(fields.instant("When the link was last regenerated.")),
      revoked_at: orNull(fields.instant("When the link was revoked; it never opens again.")),
      revoked_by: orNull(fields.ref("person who revoked the link")),
    },
  }),
  { nullable: ["created_by", "updated_by"] },
);

const FormLinkToken = z
  .object({
    form_link_id: fields.uuid("The new link."),
    token: tokenField("xfrm", "{Gateway origin}/forms/{token}"),
    access_code: accessCode,
    expires_at: fields.instant("When the link stops opening."),
  })
  .meta({
    id: "FormLinkToken",
    description: "A new form link with its token and access code, shown once.",
  });

const FormLinkRegenerated = z
  .object({
    token: tokenField("xfrm", "{Gateway origin}/forms/{token}"),
    access_code: accessCode,
    expires_at: fields.instant("When the link stops opening; regenerating keeps the expiry."),
  })
  .meta({
    id: "FormLinkRegenerated",
    description: "A regenerated form link's new token and access code, shown once.",
  });

/**
 * A public form link's response. The frozen FormSubmission schema requires a member submitter, so a link
 * response has its own resource and formSubmissions never answers one.
 */
// Written without a person (an open, a read or a link response), so the last updater can be nobody.
const FormLinkResponse = editDefinition(
  defineResource({
    name: "FormLinkResponse",
    table: "app.form_submissions",
    description:
      "A response to a public form link (ADR 0141): the respondent's name and email, answers against one template version and the score. It stays Submitted until `formLinkResponses.decide`, and approving one on a project makes its record. `formSubmissions` lists members' submissions only.",
    serverSet: [
      "form_link_id",
      "form_template_id",
      "form_template_version_id",
      "project_id",
      "record_id",
      "respondent_name",
      "respondent_email",
      "answers",
      "score",
      "max_score",
      "passed",
      "submission_state",
      "decided_by_membership_id",
      "decision_note",
    ],
    fields: {
      form_link_id: fields.ref("public link the response came through"),
      form_template_id: fields.ref("form answered"),
      form_template_version_id: fields.ref("version answered"),
      project_id: orNull(fields.ref("project the response belongs to")),
      record_id: orNull(fields.ref("record the approval made")),
      respondent_name: fields.text("Name the respondent gave.", "Rae Ortiz", 200),
      respondent_email: fields.text(
        "Email the respondent gave, lower case.",
        "rae@example.com",
        320,
      ),
      answers: z
        .record(z.string(), z.unknown())
        .meta({ description: "Answers keyed by field key.", example: { hoist_ok: true } }),
      score: z.number().nullable().meta({ description: "Points earned.", example: 3 }),
      max_score: z
        .number()
        .nullable()
        .meta({ description: "Points available on the shown fields.", example: 3 }),
      passed: z
        .boolean()
        .nullable()
        .meta({ description: "Whether the pass score was met.", example: true }),
      submission_state: z
        .enum(Constants.app.Enums.form_submission_state)
        .meta({ description: "Where the response stands.", example: "Submitted" }),
      decided_by_membership_id: orNull(fields.ref("member who decided")),
      decision_note: orNull(
        fields.text("Why it was rejected, or a note on approval.", "Thanks.", 2000),
      ),
    },
  }),
  { nullable: ["created_by", "updated_by"] },
);

const OutsideAccessRow = defineResource({
  name: "OutsideAccessRow",
  table: "app.project_outside_access",
  base: "view",
  description:
    "One thing that reaches a project from outside the org: a live or display link, file link, advance or signing link, roster invitation, pack recipient, intake link, form link or engagement (ADR 0141). Each source's own row level security decides. `filter[project_id][eq]` is required: a list without it answers 400, because a file link's project is looked up per row. No token, code or password: none is stored readably.",
  fields: {
    project_id: fields.uuid("Project reached."),
    source: z
      .enum([
        "Live view link",
        "Display link",
        "File link",
        "Advance link",
        "Signing link",
        "Roster invitation",
        "Pack recipient",
        "Intake link",
        "Form link",
        "Engagement",
      ])
      .meta({ description: "What kind of access it is.", example: "Intake link" }),
    source_id: fields.uuid(
      "Id of the row in its source table, for its own revoke or regenerate operation.",
    ),
    label: orNull(
      fields.text(
        "What the row is, in the words people wrote; null for a live link with no note and a roster invitation.",
        "Audio vendors",
        400,
      ),
    ),
    recipient_email: orNull(
      fields.text("Who it was sent to, when the source names one.", "cleo@example.com", 320),
    ),
    token_hint: orNull(fields.text("Last four characters of the token.", "3f9a", 4)),
    link_state: fields.text(
      "Active, Locked, Expired, Revoked or Used for links; a roster invitation's or engagement's state.",
      "Active",
      40,
    ),
    expires_at: orNull(fields.instant("When it stops working; null for an engagement.")),
    open_count: z
      .number()
      .int()
      .nullable()
      .meta({ description: "Successful opens, where the source counts them.", example: 3 }),
    last_opened_at: orNull(fields.instant("Last successful open, where the source records it.")),
    created_at: fields.instant("When it was made."),
    created_by: orNull(fields.uuid("Person who made it.")),
    viewer_can_manage: z.boolean().meta({
      description:
        "Whether the caller may revoke or regenerate it: the check that source's own operation makes.",
      example: true,
    }),
  },
});

const reason = fields.text(
  "Why, at least 10 characters to decline.",
  "We already have this crew booked.",
  1000,
);

export const outsideAccessResources: readonly ResourceSpec[] = [
  resource("Platform", "/stakeholder-packs", StakeholderPack, {
    verbs: ["list", "get"],
    actions: [
      collectionAction("create", {
        summary: "Create a stakeholder pack",
        description:
          "Makes a pack on a project through app.create_stakeholder_pack. Needs membership of the project's org and projects.settings.write on the project (a partner org never qualifies), an org that is not read-only (422 `org_read_only`), and an expiry after now and within 90 days (422 `stakeholder_pack_expiry_range`).",
        body: z
          .object({
            project_id: fields.ref("project the pack shares from"),
            name: fields.text("Pack name shown to recipients.", "Client pack", 120),
            expires_at: fields.instant("When the pack stops opening."),
            message: fields.text("Message shown to recipients.", "Welcome.", 2000).optional(),
            note: fields
              .text("For the team; never shown to recipients.", "Finance", 200)
              .optional(),
          })
          .meta({ id: "StakeholderPackRequest", description: "A new stakeholder pack." }),
        response: StakeholderPack.read,
        rpc: "create_stakeholder_pack",
        status: 201,
      }),
      itemAction("update", {
        summary: "Change a stakeholder pack",
        description:
          "Changes the name, message, note and expiry through app.update_stakeholder_pack. An earlier expiry stops every link and device grant at once. Refused for a revoked pack (422 `stakeholder_pack_revoked`) and a read-only org (422 `org_read_only`).",
        body: z
          .object({
            name: fields.text("Pack name shown to recipients.", "Client pack", 120),
            expires_at: fields.instant("When the pack stops opening."),
            message: orNull(fields.text("Message shown to recipients.", "Welcome.", 2000)),
            note: orNull(fields.text("For the team; never shown to recipients.", "Finance", 200)),
          })
          .meta({ id: "StakeholderPackChange", description: "A stakeholder pack's new details." }),
        response: StakeholderPack.read,
        rpc: "update_stakeholder_pack",
      }),
      itemAction("revoke", {
        summary: "Revoke a stakeholder pack",
        description:
          "Revokes the pack through app.revoke_stakeholder_pack: every device grant is deleted and every emailed link revoked. Allowed in a read-only org, since it withdraws access. Revoking a revoked pack answers it unchanged.",
        response: StakeholderPack.read,
        rpc: "revoke_stakeholder_pack",
      }),
      itemAction("setSchedule", {
        segment: "schedule",
        summary: "Set a pack's delivery schedule",
        description:
          "Sets when the pack emails its recipients a fresh sign-in link through app.set_stakeholder_pack_schedule: Daily, Weekly (weekday 1 to 7) or Monthly (day 1 to 28) at a local hour, in the project's zone by default. A slot after the pack's expiry is refused (422 `stakeholder_pack_schedule_past_expiry`). Outside recipients get a link, never a report file.",
        body: z
          .object({
            cadence: PackCadence,
            local_hour: fields.int("Hour of the day it sends, 0 to 23.", 9),
            weekday: fields.int("Weekly only: 1 (Monday) to 7.", 1).optional(),
            month_day: fields.int("Monthly only: 1 to 28.", 1).optional(),
            time_zone: fields
              .text("IANA time zone; the project's by default.", "America/New_York", 80)
              .optional(),
          })
          .meta({ id: "StakeholderPackScheduleRequest", description: "When a pack sends." }),
        response: StakeholderPackSchedule,
        rpc: "set_stakeholder_pack_schedule",
      }),
      itemAction("clearSchedule", {
        segment: "schedule/clear",
        summary: "Clear a pack's delivery schedule",
        description:
          "Turns the schedule off through app.clear_stakeholder_pack_schedule; deliveries already queued still go.",
        response: StakeholderPack.read,
        rpc: "clear_stakeholder_pack_schedule",
      }),
    ],
  }),
  resource("Platform", "/stakeholder-pack-items", StakeholderPackItem, {
    verbs: ["list"],
    actions: [
      collectionAction("add", {
        summary: "Add an item to a stakeholder pack",
        description:
          "Adds one live link or one file, last in order, through app.add_stakeholder_pack_item. A live link must be one the caller may manage, on the pack's project, neither revoked nor expired (422 `stakeholder_pack_item_link`). A file must be readable by the caller, of the pack's project, with a clean current version (422 `stakeholder_pack_item_file`), and Public or Internal (422 `stakeholder_pack_item_classified`). At most 30 items (422 `stakeholder_pack_item_limit`).",
        body: z
          .object({
            stakeholder_pack_id: fields.ref("pack the item joins"),
            live_link_id: fields.ref("live link to share").optional(),
            attachment_id: fields.ref("file to share").optional(),
            title: fields.text("Item title shown to recipients.", "Floor plan", 200),
            requires_acknowledgement: z
              .boolean()
              .optional()
              .meta({ description: "Ask each recipient to type their name.", example: false }),
          })
          .meta({
            id: "StakeholderPackItemRequest",
            description: "An item for a stakeholder pack.",
          }),
        response: StakeholderPackItem.read,
        rpc: "add_stakeholder_pack_item",
        status: 201,
      }),
      itemAction("remove", {
        summary: "Remove an item from a stakeholder pack",
        description:
          "Removes the item through app.remove_stakeholder_pack_item; recipients stop seeing it at once.",
        response: z
          .object({ id: fields.uuid("The item removed.") })
          .meta({ id: "StakeholderPackItemRemoved", description: "The item removed." }),
        rpc: "remove_stakeholder_pack_item",
      }),
    ],
  }),
  resource("Platform", "/stakeholder-pack-recipients", StakeholderPackRecipient, {
    verbs: ["list", "get"],
    actions: [
      collectionAction("add", {
        summary: "Add a recipient to a stakeholder pack",
        description:
          "Adds a person through app.add_stakeholder_pack_recipient and answers their 6-digit access code once, to give by phone or message. Refuses a revoked pack, a read-only org, a malformed email (422 `stakeholder_pack_recipient_email`), a second live recipient with the same email (422 `stakeholder_pack_recipient_duplicate`), more than 200 recipients (422 `stakeholder_pack_recipient_limit`).",
        body: z
          .object({
            stakeholder_pack_id: fields.ref("pack the recipient may open"),
            full_name: fields.text("Recipient's name.", "Cleo Client", 200),
            email: fields.text("Recipient's email.", "cleo@example.com", 320),
            counterparty_id: fields.ref("supplier the recipient works for").optional(),
            label: fields.text("Group, for example a department.", "Finance", 80).optional(),
          })
          .meta({
            id: "StakeholderPackRecipientRequest",
            description: "A recipient for a stakeholder pack.",
          }),
        response: z
          .object({ recipient_id: fields.uuid("The new recipient."), access_code: accessCode })
          .meta({
            id: "StakeholderPackRecipientCode",
            description: "A new recipient and their access code, shown once.",
          }),
        rpc: "add_stakeholder_pack_recipient",
        status: 201,
      }),
      itemAction("resetCode", {
        segment: "reset-code",
        summary: "Reset a recipient's access code",
        description:
          "Draws a new 6-digit code through app.reset_stakeholder_pack_recipient_code, answered once. Wrong-code attempts reset, which unlocks a locked recipient, and every device grant is dropped.",
        response: z.object({ access_code: accessCode }).meta({
          id: "StakeholderPackRecipientCodeReset",
          description: "A recipient's new access code, shown once.",
        }),
        rpc: "reset_stakeholder_pack_recipient_code",
      }),
      itemAction("revoke", {
        summary: "Revoke a recipient",
        description:
          "Revokes one recipient through app.revoke_stakeholder_pack_recipient: their device grants are deleted and emailed links revoked. Allowed in a read-only org.",
        response: StakeholderPackRecipient.read,
        rpc: "revoke_stakeholder_pack_recipient",
      }),
      collectionAction("send", {
        segment: "send",
        summary: "Email a pack's sign-in links now",
        description:
          "Queues an Invite or Resend per recipient through app.send_stakeholder_pack. Revoked and unsubscribed recipients, addresses on the org's suppression list, and any recipient already sent 3 manual emails in the last hour are skipped. The email never carries the access code. Answers how many were queued.",
        body: z
          .object({
            stakeholder_pack_id: fields.ref("pack to send"),
            recipient_ids: z.array(fields.uuid("A recipient.")).optional().meta({
              description: "Only these recipients; every live recipient when left out.",
              example: [],
            }),
          })
          .meta({ id: "StakeholderPackSendRequest", description: "Which recipients to email." }),
        response: z
          .object({ queued: fields.int("Deliveries queued.", 3) })
          .meta({ id: "StakeholderPackSent", description: "How many deliveries were queued." }),
        rpc: "send_stakeholder_pack",
      }),
    ],
  }),
  resource("Platform", "/stakeholder-pack-events", StakeholderPackEvent, { verbs: ["list"] }),
  resource("Platform", "/vendor-intake-links", VendorIntakeLink, {
    verbs: ["list", "get"],
    actions: [
      collectionAction("create", {
        summary: "Create a vendor intake link",
        description:
          "Makes a reusable link through app.create_vendor_intake_link. Needs membership of the project's org and opportunities.engagement.write on the project. Refuses an employee classification (422 `vendor_intake_classification`), a Vendor link without a counterparty type (422 `vendor_intake_counterparty_type`), terms that are not one rate card row (422 `vendor_intake_rate_card`), an expiry past 90 days (422 `vendor_intake_expiry_range`), an agreement without a clean upload (422 `intake_agreement_file`) or above Internal (422 `intake_agreement_classified`). Answers 201 with the token and code, shown once.",
        body: z
          .object({
            project_id: fields.ref("project the engagements join"),
            title: fields.text(
              "What the link is for, shown on the public page.",
              "Audio vendors",
              120,
            ),
            role_type: z
              .enum(["Vendor", "Contractor"])
              .meta({ description: "Vendor or Contractor.", example: "Vendor" }),
            role_code: fields.text("Canon role.", "9000.50.02", 40),
            worker_classification: fields.text(
              "Canon worker classification.",
              "VENDOR_SUPPLIED",
              60,
            ),
            pay_basis: fields.text("Canon pay basis.", "Day Rate", 60),
            arrangement: fields.text("Canon arrangement.", "Per Engagement", 60),
            start_date: fields.date("First day of the engagements."),
            expires_at: fields.instant("When the link stops opening."),
            end_date: fields.date("Last day of the engagements.").optional(),
            counterparty_type: fields
              .text("Counterparty type a new vendor gets.", "AV Integrator", 80)
              .optional(),
            agreement_document_id: fields.ref("Knowledge document each requester signs").optional(),
            instructions: fields
              .text("Instructions on the public page.", "Send us your details.", 2000)
              .optional(),
            note: fields.text("For the team.", "Summer season", 200).optional(),
            collect_tax_form: z
              .boolean()
              .optional()
              .meta({ description: "Ask for a tax form.", example: true }),
            collect_payout: z
              .boolean()
              .optional()
              .meta({ description: "Ask for a payout reference.", example: true }),
            collect_invoice: z
              .boolean()
              .optional()
              .meta({ description: "Take a first invoice draft.", example: false }),
            max_requests: fields.int("Most requests the link takes, 1 to 500.", 50).optional(),
          })
          .meta({ id: "VendorIntakeLinkRequest", description: "A new vendor intake link." }),
        response: IntakeLinkToken,
        rpc: "create_vendor_intake_link",
        status: 201,
      }),
      itemAction("regenerate", {
        summary: "Regenerate a vendor intake link",
        description:
          "Draws a new token and code through app.regenerate_vendor_intake_link; wrong-code attempts reset, which unlocks a locked link, and every grant is dropped. A revoked link (422 `vendor_intake_link_revoked`) and a read-only org (422 `org_read_only`) are refused. Answers them once.",
        response: IntakeLinkRegenerated,
        rpc: "regenerate_vendor_intake_link",
      }),
      itemAction("revoke", {
        summary: "Revoke a vendor intake link",
        description:
          "Revokes the link through app.revoke_vendor_intake_link so it never opens again; requests already sent stay for the team to decide. Allowed in a read-only org.",
        response: VendorIntakeLink.read,
        rpc: "revoke_vendor_intake_link",
      }),
    ],
  }),
  resource("Platform", "/vendor-intake-requests", VendorIntakeRequest, {
    verbs: ["list", "get"],
    actions: [
      itemAction("approve", {
        summary: "Approve a vendor intake request",
        description:
          "Approves into an Onboarding engagement on the link's terms through app.decide_vendor_intake: the org's counterparty for the account is reused or added, Tax Form and Payout Details items are marked submitted but never verified, and the agreement is signed for the pinned version or stays Sent. The requester and anyone in the vendor account are refused (422 `sod_vendor_intake_self`); a decided request answers 422 `vendor_intake_not_pending`; the plan limit surfaces its own code.",
        body: z
          .object({ reason: reason.optional() })
          .meta({ id: "VendorIntakeApproval", description: "An optional note." }),
        response: VendorIntakeRequest.read,
        rpc: "decide_vendor_intake",
      }),
      itemAction("decline", {
        summary: "Decline a vendor intake request",
        description:
          "Declines through app.decide_vendor_intake with a reason of at least 10 characters (422 `vendor_intake_decline_reason`). The tax form and payout reference written for it are soft-deleted when nothing else needs them.",
        body: z
          .object({ reason })
          .meta({ id: "VendorIntakeDecline", description: "Why it is declined." }),
        response: VendorIntakeRequest.read,
        rpc: "decide_vendor_intake",
      }),
    ],
  }),
  resource("Platform", "/form-links", FormLink, {
    verbs: ["list", "get"],
    actions: [
      collectionAction("create", {
        summary: "Create a public form link",
        description:
          "Makes a public link through app.create_form_link. Needs membership and knowledge.sop.publish, a Published form (422 `form_not_published`) with no photo field, signature or GPS stamp (422 `form_link_unsupported`), and an expiry within 90 days (422 `form_link_expiry_range`). Answers 201 with the token and code, shown once.",
        body: z
          .object({
            form_template_id: fields.ref("form the link answers"),
            expires_at: fields.instant("When the link stops opening."),
            project_id: fields.ref("project the responses belong to").optional(),
            daily_cap: fields.int("Most responses in any 24 hours, 1 to 1000.", 200).optional(),
            max_responses: fields.int("Most responses in all, 1 to 10000.", 500).optional(),
            one_per_email: z
              .boolean()
              .optional()
              .meta({ description: "Each email answers once.", example: true }),
            note: fields.text("For the team.", "Supplier check-in", 200).optional(),
          })
          .meta({ id: "FormLinkRequest", description: "A new public form link." }),
        response: FormLinkToken,
        rpc: "create_form_link",
        status: 201,
      }),
      itemAction("regenerate", {
        summary: "Regenerate a public form link",
        description:
          "Draws a new token and code through app.regenerate_form_link; wrong-code attempts reset and every grant is dropped. A revoked link and a read-only org are refused. Answers them once.",
        response: FormLinkRegenerated,
        rpc: "regenerate_form_link",
      }),
      itemAction("revoke", {
        summary: "Revoke a public form link",
        description:
          "Revokes the link through app.revoke_form_link; responses already in stay. Allowed in a read-only org.",
        response: FormLink.read,
        rpc: "revoke_form_link",
      }),
    ],
  }),
  resource("Platform", "/form-link-responses", FormLinkResponse, {
    verbs: ["list", "get"],
    actions: [
      itemAction("decide", {
        summary: "Approve or reject a public form response",
        description:
          "Decides through app.decide_form_submission as a holder of the form's approver role or knowledge.sop.publish. A rejection needs a note. Approving a response on a project makes its record of the form's kind and subtype.",
        body: z
          .object({
            approve: z
              .boolean()
              .meta({ description: "True to approve, false to reject.", example: true }),
            note: fields
              .text("Why it is rejected, or a note on approval.", "Thanks.", 2000)
              .optional(),
          })
          .meta({
            id: "FormLinkResponseDecision",
            description: "The decision on a public form response.",
          }),
        response: FormLinkResponse.read,
        rpc: "decide_form_submission",
      }),
    ],
  }),
  resource("Platform", "/outside-access", OutsideAccessRow, {
    verbs: ["list"],
    op: "outsideAccess",
  }),
];

/**
 * Reading needs projects.project.read or the source's own read; the database enforces
 * projects.settings.write, opportunities.engagement.write and knowledge.sop.publish on every action.
 */
export const outsideAccessCapabilities: Readonly<Record<string, CapabilityRule>> = {
  stakeholderPacks: {
    read: "projects.project.read",
    actions: {
      create: "projects.project.read",
      update: "projects.project.read",
      revoke: "projects.project.read",
      setSchedule: "projects.project.read",
      clearSchedule: "projects.project.read",
    },
  },
  stakeholderPackItems: {
    read: "projects.project.read",
    actions: { add: "projects.project.read", remove: "projects.project.read" },
  },
  stakeholderPackRecipients: {
    read: "projects.project.read",
    actions: {
      add: "projects.project.read",
      resetCode: "projects.project.read",
      revoke: "projects.project.read",
      send: "projects.project.read",
    },
  },
  stakeholderPackEvents: { read: "projects.project.read" },
  vendorIntakeLinks: {
    read: "opportunities.engagement.read",
    actions: {
      create: "opportunities.engagement.read",
      regenerate: "opportunities.engagement.read",
      revoke: "opportunities.engagement.read",
    },
  },
  vendorIntakeRequests: {
    read: "opportunities.engagement.read",
    actions: { approve: "opportunities.engagement.read", decline: "opportunities.engagement.read" },
  },
  formLinks: {
    read: "knowledge.sop.publish",
    actions: {
      create: "knowledge.sop.publish",
      regenerate: "knowledge.sop.publish",
      revoke: "knowledge.sop.publish",
    },
  },
  formLinkResponses: {
    read: "knowledge.sop.publish",
    actions: { decide: "knowledge.sop.publish" },
  },
  outsideAccess: { read: "projects.project.read" },
};
