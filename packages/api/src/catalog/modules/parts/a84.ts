/**
 * A84 (RRR-129, finding A65-018, migrations 1410 and 1411, ADR 0038): calendar feeds rotate in
 * place, a person's own feed across their engagements (Gateway), the project inbox address, and
 * filing or discarding inbound mail. catalog/modules/platform.ts spreads them into the Platform
 * additions; handlers/parts/a84.ts serves them.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { editDefinition, orNull } from "../../correct.ts";
import { collectionAction, itemAction, resource } from "../../define.ts";
import type { ActionSpec, ResourceSpec } from "../../types.ts";

/** A new or rotated feed and its subscription token, shown once (also `calendarFeeds.create`). */
export const CalendarFeedToken = z
  .object({
    calendar_feed_id: fields.ref("calendar feed"),
    feed_token: z.string().min(1).meta({
      description:
        "The token of the feed's subscription URL. Shown once; only its hash is stored, and revoking the feed ends it.",
      example: "cal_9fQ2mX4vT7kL1pR8",
    }),
  })
  .meta({
    id: "CalendarFeedToken",
    description: "A newly created calendar feed and its subscription token, shown once.",
  });

const audited = (def: Parameters<typeof editDefinition>[0]) =>
  editDefinition(def, { nullable: ["created_by", "updated_by"] });

const PersonCalendarFeed = defineResource({
  name: "PersonCalendarFeed",
  table: "app.person_calendar_feeds",
  base: "global",
  description:
    "A person's own iCalendar feed across every org they work with through an engagement (1410): their published shifts and the meetings, milestones and deadlines shared with them. Only a hash of the token is kept; the token is shown once by personCalendarFeeds.create and personCalendarFeeds.rotate, and deleting the feed revokes it for good.",
  fields: {
    person_id: fields.ref("person who owns the feed; always the caller"),
    token_hint: fields.text("Last four characters of the token.", "a1b2", 4),
    last_accessed_at: orNull(fields.instant("Last time a calendar fetched the feed.")),
    rotated_at: orNull(fields.instant("When the token was last replaced.")),
  },
  serverSet: ["person_id", "token_hint", "last_accessed_at", "rotated_at"],
});

const ProjectInbox = audited(
  defineResource({
    name: "ProjectInbox",
    table: "app.inbound_addresses",
    description:
      "A project inbox address (0550, 1411): mail forwarded to `<local_part>@<receiving domain>` lands as inbound mail of the project for a coordinator to file. One live address per project; it is never edited, only replaced or disabled.",
    fields: {
      project_id: fields.ref("project the inbox belongs to"),
      local_part: fields.text(
        "Part before the @ of the receiving domain: the project key and a random suffix.",
        "nwl-0a1b2c3d4e",
        63,
      ),
      disabled_at: orNull(fields.instant("When the address stopped accepting mail.")),
    },
    serverSet: ["project_id", "local_part", "disabled_at"],
  }),
);

const InboundMessage = audited(
  defineResource({
    name: "InboundMessage",
    table: "app.inbound_messages",
    description:
      "Mail received (0550, 1411): forwarded to a project inbox, or a reply to a notification email. People who file documents on the project read its inbox mail; a person reads their own replies. Project inbox mail is filed once, as a Document record of the project, or discarded with a reason.",
    fields: {
      purpose: z
        .enum(["Project Inbox", "Reply"])
        .meta({ description: "What the mail was sent to.", example: "Project Inbox" }),
      inbound_address_id: orNull(fields.ref("project inbox the mail was sent to")),
      from_address: fields.text("Sender address.", "rigging@bayside-audio.test", 320),
      subject_line: orNull(fields.text("Subject.", "Rigging plot v4", 998)),
      body_text: orNull(
        fields.longText("Plain-text body with quoted text stripped.", "Updated plot attached."),
      ),
      dkim_verified: fields.bool("True when the sender's DKIM signature verified.", true),
      inbound_status: z
        .enum(["Received", "Verified", "Filed", "Rejected"])
        .meta({ description: "Processing status.", example: "Verified" }),
      rejection_reason: orNull(fields.text("Why the mail was rejected.", "DKIM failed.", 500)),
      received_at: fields.instant("When the mail arrived."),
      filed_document_id: orNull(fields.ref("document the mail was filed as")),
      filed_record_id: orNull(fields.ref("record of the project the mail was filed to")),
      filed_by: orNull(fields.ref("person who filed the mail")),
      filed_at: orNull(fields.instant("When the mail was filed.")),
      discarded_at: orNull(fields.instant("When the mail was discarded.")),
      discarded_by: orNull(fields.ref("person who discarded the mail")),
      discard_reason: orNull(fields.text("Why the mail was discarded.", "Spam.", 500)),
    },
    serverSet: [
      "purpose",
      "inbound_address_id",
      "from_address",
      "subject_line",
      "body_text",
      "dkim_verified",
      "inbound_status",
      "rejection_reason",
      "received_at",
      "filed_document_id",
      "filed_record_id",
      "filed_by",
      "filed_at",
      "discarded_at",
      "discarded_by",
      "discard_reason",
    ],
  }),
);

export const a84Resources: readonly ResourceSpec[] = [
  resource("Platform", "/person-calendar-feeds", PersonCalendarFeed, {
    verbs: ["list", "get", "delete"],
    actions: [
      collectionAction("create", {
        segment: "",
        summary: "Create a personal calendar feed",
        description:
          "Creates the caller's own feed across every org they work with (app.create_person_calendar_feed) and returns its token once. At most 20 live feeds (calendar_feed_limit: 422).",
        response: CalendarFeedToken,
        rpc: "app.create_person_calendar_feed",
        status: 201,
      }),
      itemAction("rotate", {
        summary: "Get a new link for a personal calendar feed",
        description:
          "Replaces the feed's token (app.rotate_person_calendar_feed) and returns the new one once. The old subscription URL answers 404 at once.",
        response: CalendarFeedToken,
        rpc: "app.rotate_person_calendar_feed",
      }),
    ],
  }),
  resource("Platform", "/project-inboxes", ProjectInbox, {
    verbs: ["list", "get"],
    actions: [
      collectionAction("create", {
        segment: "",
        summary: "Create a project's inbox address",
        description:
          "Returns the project's live inbox address, creating it when there is none (app.create_project_inbox, projects.settings.write on the project).",
        body: z
          .object({ project_id: fields.ref("project the inbox is for") })
          .meta({ id: "ProjectInboxCreate", description: "The project to give an inbox." }),
        rpc: "app.create_project_inbox",
        status: 201,
      }),
      itemAction("replace", {
        summary: "Replace a project's inbox address",
        description:
          "Disables the address and returns the project's new one (app.replace_project_inbox). Mail to the old address is no longer accepted.",
        rpc: "app.replace_project_inbox",
      }),
      itemAction("disable", {
        summary: "Turn off a project's inbox",
        description:
          "Stops the address accepting mail (app.disable_project_inbox). Mail already received stays; a disabled address never comes back.",
        rpc: "app.disable_project_inbox",
      }),
    ],
  }),
  resource("Platform", "/inbound-messages", InboundMessage, {
    verbs: ["list", "get"],
    order: { by: ["received_at"], numeric: false, descending: true },
    actions: [
      itemAction("file", {
        summary: "File inbound mail as a document",
        description:
          "Files verified project inbox mail as a Document record of the project, optionally to a record of the project the caller can open (app.file_inbound_message); the subject, sender and text are posted as a comment on the document and the record. Mail is filed once (inbound_message_triaged: 422); unverified mail is refused (inbound_message_unverified: 422).",
        body: z
          .object({
            title: fields
              .text("Document title; the subject when omitted.", "Rigging plot v4", 200)
              .optional(),
            record_id: fields.ref("record of the project to file the mail to").optional(),
          })
          .meta({ id: "InboundMessageFileRequest", description: "How to file the mail." }),
        rpc: "app.file_inbound_message",
      }),
      itemAction("discard", {
        summary: "Discard inbound mail",
        description:
          "Discards project inbox mail with an optional reason (app.discard_inbound_message). The mail is kept and the audit ledger records who discarded it and when.",
        body: z
          .object({
            reason: fields.text("Why the mail is discarded.", "Spam.", 500).optional(),
          })
          .meta({ id: "InboundMessageDiscardRequest", description: "Why the mail is discarded." }),
        rpc: "app.discard_inbound_message",
      }),
    ],
  }),
];

export const a84Actions: Readonly<Record<string, readonly ActionSpec[]>> = {
  calendarFeeds: [
    itemAction("rotate", {
      summary: "Get a new link for a calendar feed",
      description:
        "Replaces the token of one of the caller's feeds (app.rotate_calendar_feed) and returns the new one once. The old subscription URL answers 404 at once; a revoked feed is not found.",
      response: CalendarFeedToken,
      rpc: "app.rotate_calendar_feed",
    }),
  ],
};

export const a84Capabilities: Readonly<Record<string, CapabilityRule>> = {
  calendarFeeds: { actions: { rotate: "me.calendar_feeds.write" } },
  personCalendarFeeds: {
    read: "me.calendar_feeds.write",
    write: "me.calendar_feeds.write",
    actions: { create: "me.calendar_feeds.write", rotate: "me.calendar_feeds.write" },
  },
  projectInboxes: {
    read: "projects.project.read",
    write: "projects.settings.write",
    actions: {
      create: "projects.settings.write",
      replace: "projects.settings.write",
      disable: "projects.settings.write",
    },
  },
  inboundMessages: {
    read: "knowledge.document.write",
    write: "knowledge.document.write",
    actions: { file: "knowledge.document.write", discard: "knowledge.document.write" },
  },
};
