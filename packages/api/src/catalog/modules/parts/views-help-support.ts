/**
 * Views, help and support (A31): additive Platform resources over migrations 0641 to 0643. Saved views
 * themselves are A18's frozen `savedViews`; these add their team shares and per-page defaults, the
 * person's guided tour progress and tip dismissals, and support requests with their messages and
 * consented diagnostics. catalog/modules/platform.ts spreads them into the Platform additions.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { editDefinition, orNull } from "../../correct.ts";
import { collectionAction, itemAction, resource, transitionBody } from "../../define.ts";
import type { ResourceSpec } from "../../types.ts";
import { Constants } from "@xos/data/database.types";

/** Audit people are nullable on every resource (ADR 0023): seed and platform rows carry none. */
const audited = (def: Parameters<typeof editDefinition>[0]) =>
  editDefinition(def, { nullable: ["created_by", "updated_by"] });

const key = (description: string, example: string) =>
  z
    .string()
    .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/)
    .max(100)
    .meta({ description, example });

const collectionKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\/[a-z][a-z0-9_]*)?$/)
  .meta({
    description: "Collection (page) the default applies to, as saved views name it.",
    example: "logistics/shipments",
  });

const TourState = z.enum(Constants.app.Enums.tour_state);
const SupportQueue = z.enum(Constants.app.Enums.support_queue);
const SupportState = z.enum(Constants.app.Enums.support_ticket_state);
const SupportSeverity = z.enum(Constants.app.Enums.support_severity);
const SupportCategory = z.enum(Constants.app.Enums.support_category);
const SupportChannel = z.enum(Constants.app.Enums.support_channel);

const SavedViewShare = audited(
  defineResource({
    name: "SavedViewShare",
    table: "app.saved_view_shares",
    description:
      "A saved view shared with one team of its org (0641). Only the view's owner shares or unshares it; team members open it and see only the rows their own access allows.",
    fields: {
      saved_view_id: fields.ref("saved view"),
      team_id: fields.ref("team of the same org"),
    },
    immutable: ["saved_view_id", "team_id"],
  }),
);

const SavedViewDefault = audited(
  defineResource({
    name: "SavedViewDefault",
    table: "app.saved_view_defaults",
    description:
      "The saved view the caller opens by default on a page (0641): one per member and collection. Creating one replaces the earlier default of the page (app.set_saved_view_default).",
    fields: {
      membership_id: fields.ref("membership of the caller, set by the server"),
      collection_key: collectionKey,
      saved_view_id: fields.ref("saved view the caller can read, of the same collection"),
    },
    serverSet: ["membership_id", "collection_key"],
    immutable: ["saved_view_id"],
  }),
);

const TourProgress = audited(
  defineResource({
    name: "TourProgress",
    table: "app.tour_progress",
    description:
      "The caller's progress through one guided tour (0642). A tour is offered once (the row exists from then on), can be replayed by moving it to Started at step 0, and is never offered again.",
    fields: {
      membership_id: fields.ref("membership of the caller, set by the server"),
      tour_key: key("Tour key from the help content.", "atlas.getting-started"),
      tour_state: TourState.meta({
        description: "Offered, Started, Completed or Dismissed.",
        example: "Started",
      }),
      step: fields.int("Last step reached, from 0.", 2),
    },
    serverSet: ["membership_id"],
    immutable: ["tour_key"],
  }),
);

const TipDismissal = audited(
  defineResource({
    name: "TipDismissal",
    table: "app.tip_dismissals",
    description:
      "A contextual tip the caller dismissed (0642). Deleting it shows the tip again; a reset dismissal is never revived.",
    fields: {
      membership_id: fields.ref("membership of the caller, set by the server"),
      tip_key: key("Tip key from the help content.", "gates"),
    },
    serverSet: ["membership_id"],
    immutable: ["tip_key"],
  }),
);

const SupportTicket = audited(
  defineResource({
    name: "SupportTicket",
    table: "app.support_tickets",
    description:
      "A request for help (0643): to the org's own admins (Organization queue) or, from holders of org.help.write, to the platform team (Platform queue), whose channel and first response deadline follow the plan. Readable by the requester and by those who answer support for the org.",
    fields: {
      membership_id: fields.ref("membership of the requester, set by the server"),
      ticket_number: fields.code("Display number, SUP-0001 upward per org.", "SUP-0001"),
      queue: SupportQueue.meta({
        description: "Organization or Platform.",
        example: "Organization",
      }),
      category: SupportCategory.meta({
        description: "What the request is about.",
        example: "Access",
      }),
      severity: SupportSeverity.meta({
        description: "Severity 1 (outage) to Severity 4 (question).",
        example: "Severity 3",
      }),
      subject: fields.text("One-line summary.", "Scanner shows an unknown zone", 200),
      body: fields.longText(
        "What happened and what the requester needs.",
        "At the north gate the scanner says the zone is unknown.",
      ),
      ticket_state: SupportState.meta({
        description: "Open, Waiting, Resolved or Closed; moved by the transition action.",
        example: "Open",
      }),
      channel: SupportChannel.meta({
        description: "In App for the Organization queue; by plan for the Platform queue.",
        example: "In App",
      }),
      first_response_due_at: orNull(
        fields.instant("Platform first response deadline from the plan; null for best effort."),
      ),
      first_responded_at: orNull(fields.instant("When a responder first answered.")),
    },
    serverSet: [
      "membership_id",
      "ticket_number",
      "ticket_state",
      "channel",
      "first_response_due_at",
      "first_responded_at",
    ],
    immutable: ["queue", "category", "severity", "subject", "body"],
  }),
);

const SupportTicketMessage = audited(
  defineResource({
    name: "SupportTicketMessage",
    table: "app.support_ticket_messages",
    description:
      "One message on a support request (0643), oldest first. Append-only; posted with the reply action.",
    fields: {
      support_ticket_id: fields.ref("support request"),
      author_membership_id: orNull(fields.ref("member who wrote it; null for the platform team")),
      body: fields.longText("Message text.", "Which zone did you pick?"),
    },
    serverSet: ["support_ticket_id", "author_membership_id", "body"],
  }),
);

const SupportTicketDiagnostics = audited(
  defineResource({
    name: "SupportTicketDiagnostics",
    table: "app.support_ticket_diagnostics",
    description:
      "Diagnostics the requester chose to attach to a support request (0643), with the moment they consented. Append-only.",
    fields: {
      support_ticket_id: fields.ref("support request"),
      consented_at: fields.instant("When the requester agreed to send the diagnostics."),
      route: orNull(fields.text("Page the requester was on.", "/demo/credentials/scans", 500)),
      app_version: orNull(fields.text("App version and build.", "4.0.0 (812)", 50)),
      device: orNull(fields.text("Browser or device and operating system.", "Safari 19 on iOS 26")),
      recent_errors: orNull(fields.longText("Recent client errors, newest first.", "TypeError")),
      screenshot_path: orNull(
        fields.text("Storage path of a screenshot.", "org/ticket/shot.png", 500),
      ),
    },
    serverSet: [
      "support_ticket_id",
      "consented_at",
      "route",
      "app_version",
      "device",
      "recent_errors",
      "screenshot_path",
    ],
  }),
);

const SupportTicketOpen = z
  .object({
    queue: SupportQueue.meta({ description: "Organization or Platform.", example: "Organization" }),
    category: SupportCategory.meta({
      description: "What the request is about.",
      example: "Access",
    }),
    severity: SupportSeverity.optional().meta({
      description: "Severity 1 to 4; Severity 3 when omitted.",
      example: "Severity 3",
    }),
    subject: fields.text("One-line summary.", "Scanner shows an unknown zone", 200),
    body: fields.longText("What happened and what the requester needs.", "Zone B denies Crew."),
    diagnostics: z
      .object({
        consent: z.literal(true).meta({
          description: "Must be true: diagnostics are stored only with the requester's consent.",
          example: true,
        }),
        route: z
          .string()
          .max(500)
          .optional()
          .meta({ description: "Page the requester was on.", example: "/demo/credentials/scans" }),
        app_version: z
          .string()
          .max(50)
          .optional()
          .meta({ description: "App version and build.", example: "4.0.0 (812)" }),
        device: z
          .string()
          .max(300)
          .optional()
          .meta({ description: "Browser or device.", example: "Safari 19 on iOS 26" }),
        recent_errors: z
          .string()
          .max(4000)
          .optional()
          .meta({ description: "Recent client errors, newest first.", example: "TypeError" }),
      })
      .optional()
      .meta({ description: "Diagnostics to attach, with consent." }),
  })
  .meta({ id: "SupportTicketOpenRequest", description: "A new support request." });

export const viewsHelpSupportResources: readonly ResourceSpec[] = [
  resource("Platform", "/saved-view-shares", SavedViewShare, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Platform", "/saved-view-defaults", SavedViewDefault, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Platform", "/tour-progress", TourProgress, {
    op: "tourProgress",
    verbs: ["list", "get", "create", "update"],
  }),
  resource("Platform", "/tip-dismissals", TipDismissal, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Platform", "/support-tickets", SupportTicket, {
    verbs: ["list", "get"],
    actions: [
      collectionAction("open", {
        segment: "",
        summary: "Open a support request",
        description:
          "Opens a request as the caller (app.open_support_ticket). The Platform queue needs org.help.write and a plan with a platform channel (support_platform_admins_only, support_plan_no_channel: 422); diagnostics need consent (support_diagnostics_consent).",
        body: SupportTicketOpen,
        response: SupportTicket.read,
        status: 201,
        rpc: "open_support_ticket",
      }),
      itemAction("transition", {
        summary: "Move a support request",
        description:
          "Moves a request with a reason (app.transition_support_ticket). Responders make any allowed move; the requester closes, reopens a resolved request or takes back a waiting one (support_ticket_transition_forbidden: 422).",
        body: transitionBody("SupportTicketTransitionRequest", SupportState, ["Open", "Waiting"]),
        response: SupportTicket.read,
        rpc: "transition_support_ticket",
      }),
      itemAction("reply", {
        summary: "Reply on a support request",
        description:
          "Adds a message as the requester or a responder (app.post_support_message). A closed request takes no messages (support_ticket_closed: 422); a requester's reply reopens a waiting request.",
        body: z
          .object({ body: fields.longText("Message text.", "Zone B, backstage.") })
          .meta({ id: "SupportTicketReplyRequest", description: "A reply on a support request." }),
        response: SupportTicketMessage.read,
        status: 201,
        rpc: "post_support_message",
      }),
    ],
  }),
  resource("Platform", "/support-ticket-messages", SupportTicketMessage, {
    verbs: ["list", "get"],
    order: { by: ["created_at"], numeric: false },
  }),
  resource("Platform", "/support-ticket-diagnostics", SupportTicketDiagnostics, {
    verbs: ["list", "get"],
  }),
];

const personal: CapabilityRule = { read: "me.preferences.write", write: "me.preferences.write" };
const support: CapabilityRule = { read: "me.account.write", write: "me.account.write" };

export const viewsHelpSupportCapabilities: Readonly<Record<string, CapabilityRule>> = {
  savedViewShares: { read: "my_work.items.read", write: "org.views.write" },
  savedViewDefaults: personal,
  tourProgress: personal,
  tipDismissals: personal,
  supportTickets: {
    ...support,
    actions: {
      open: "me.account.write",
      transition: "me.account.write",
      reply: "me.account.write",
    },
  },
  supportTicketMessages: support,
  supportTicketDiagnostics: support,
};
