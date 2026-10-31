/**
 * Run-of-show depth (B3, ADR 0142, migrations 2920 and 2921): the segment library, its cues and their department
 * calls, the copies of a segment in running orders, and the audiences of cue custom fields. catalog/modules/show.ts
 * spreads the segment library into the Show additions, catalog/modules/platform.ts the audiences into the Platform
 * additions (beside custom field definitions). Every read and write runs as the caller under row level security;
 * inserting a segment into a running order and publishing it are definer RPCs, one transaction each.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { editDefinition, orNull } from "../../correct.ts";
import { collectionAction, collectionQuery, itemAction, resource } from "../../define.ts";
import type { ResourceSpec } from "../../types.ts";

const ColorKey = z
  .string()
  .regex(/^cat-[1-7]$/)
  .meta({
    description: "One of the seven themed categorical colors, cat-1 to cat-7 (color.viz.cat-*).",
    example: "cat-4",
  });

const duration = orNull(
  z
    .string()
    .regex(/^\d{2,}:\d{2}:\d{2}(\.\d+)?$/)
    .meta({ description: "Planned length as hours:minutes:seconds.", example: "00:04:00" }),
);

const SegmentLibrary = editDefinition(
  defineResource({
    name: "SegmentLibrarySegment",
    table: "app.segment_library",
    description:
      "A reusable show segment of the org (ADR 0142): a named block of cues with their department calls, copied into running orders with `segmentLibrary.insertIntoRun` and republished to them with `segmentLibrary.publish`. Every member reads the library; holders of show.run_of_show.write org-wide edit it. `version` is the database's change counter.",
    serverSet: ["version"],
    fields: {
      name: fields.text("Segment name, unique in the org.", "Awards Block", 200),
      description: orNull(
        fields.text("What the segment is.", "Three awards and the walk-off.", 2000),
      ),
      color_key: orNull(ColorKey),
      version: fields.int(
        "Change counter, set by the database: one more for each change of the segment, its cues or their calls.",
        3,
        1,
      ),
    },
  }),
  { nullable: ["created_by", "updated_by"] },
);

const SegmentLibraryCue = editDefinition(
  defineResource({
    name: "SegmentLibraryCue",
    table: "app.segment_library_cues",
    description:
      "A cue of a library segment (at most 100 per segment), copied with the segment into running orders.",
    immutable: ["segment_library_id"],
    fields: {
      segment_library_id: fields.ref("library segment"),
      position: fields.int("Order in the segment.", 1, 1),
      label: fields.text("Cue label.", "Award One", 200),
      duration,
      description: orNull(fields.text("What happens on the cue.", "Presenter walks on.", 2000)),
      script: orNull(
        fields.text("What is said on the cue.", "Please welcome our first presenter.", 20000),
      ),
    },
  }),
  { nullable: ["created_by", "updated_by"] },
);

const SegmentLibraryCueCall = editDefinition(
  defineResource({
    name: "SegmentLibraryCueCall",
    table: "app.segment_library_cue_calls",
    description:
      "A department's call on a library cue, one per department, copied into app.cue_calls with the cue.",
    immutable: ["segment_library_cue_id"],
    fields: {
      segment_library_cue_id: fields.ref("library cue the call belongs to"),
      call_kind: z
        .enum(["Audio", "Lighting", "Video", "Special Effects", "Stage"])
        .meta({ description: "Department making the call.", example: "Lighting" }),
      instruction: fields.text("What the department does on the cue.", "LX 40 GO.", 2000),
    },
  }),
  { nullable: ["created_by", "updated_by"] },
);

const RunSegmentInstance = editDefinition(
  defineResource({
    name: "RunSegmentInstance",
    table: "app.run_segment_instances",
    description:
      "A library segment copied into a running order, with the library version the copy holds. Written only by `segmentLibrary.insertIntoRun` and `segmentLibrary.publish`.",
    serverSet: ["run_of_show_id", "segment_library_id", "library_version"],
    fields: {
      run_of_show_id: fields.ref("running order the segment was copied into"),
      segment_library_id: fields.ref("library segment copied"),
      library_version: fields.int("Version of the library segment the copy holds.", 2, 1),
    },
  }),
  { nullable: ["created_by", "updated_by"] },
);

const CueFieldAudience = editDefinition(
  defineResource({
    name: "CueFieldAudience",
    table: "app.cue_field_audiences",
    description:
      "Who a cue custom field is shown to (ADR 0142): Crew (Atlas running orders; members read every value their access allows either way), Showcaller (showcaller link portals) or Client (Clients engaged on the project, in Gateway). A new cue field starts with Crew. A Person, Money or Email field never takes Showcaller or Client (422 `cue_field_audience_type`), and an audience names a cue field (422 `cue_field_audience_target`).",
    immutable: ["custom_field_definition_id", "audience"],
    fields: {
      custom_field_definition_id: fields.ref("cue custom field"),
      audience: z
        .enum(["Crew", "Showcaller", "Client"])
        .meta({ description: "Who the field is for.", example: "Client" }),
    },
  }),
  { nullable: ["created_by", "updated_by"] },
);

const InstanceId = z
  .object({ segment_instance_id: fields.uuid("The new copy of the segment in the running order.") })
  .meta({ id: "SegmentInsertResult", description: "The copy a segment insert made." });

const PublishResults = z
  .object({
    data: z
      .array(
        z.object({
          run_of_show_id: fields.uuid("Running order."),
          segment_instance_id: orNull(
            fields.uuid("Copy of the segment in it, or null when it has none."),
          ),
          outcome: z.enum(["Published", "Current", "Called", "Linked", "No Instance"]).meta({
            description:
              "Published (replaced with the current version), Current (already it), Called (a cue was called) or Linked (a cue is an artist's set time), both left untouched, or No Instance.",
            example: "Published",
          }),
        }),
      )
      .meta({ description: "One row per copy of the segment in each chosen running order." }),
  })
  .meta({
    id: "SegmentPublishResults",
    description: "What publishing did in each chosen running order.",
  });

export const segmentLibraryResources: readonly ResourceSpec[] = [
  resource("Show", "/segment-library", SegmentLibrary, {
    op: "segmentLibrary",
    label: "library segment",
    actions: [
      itemAction("insertIntoRun", {
        segment: "insert-into-run",
        summary: "Copy a library segment into a running order",
        description:
          "Copies the segment's cues and their department calls into a running order of the same org through app.insert_library_segment, before the cue at the 1-based place `before_position` (omitted, at the end), renumbering the running order 1..n in one transaction. With `starts_at` the copies are planned from it and the durations before them; without it they are unplanned. Needs show.run_of_show.write on the project. Refuses an empty segment (422 `segment_library_empty`), a place at or before the last called cue (422 `segment_insert_before_called`) and a running order that would pass 300 cues (422 `segment_insert_cue_limit`).",
        body: z
          .object({
            run_of_show_id: fields.ref("running order to copy the segment into"),
            before_position: fields
              .int("1-based place the segment goes before; omit to append.", 3, 1)
              .optional(),
            starts_at: fields.instant("When the segment's first cue is planned.").optional(),
          })
          .meta({ id: "SegmentInsertRequest", description: "Where to copy the segment." }),
        response: InstanceId,
        rpc: "insert_library_segment",
        status: 201,
      }),
      itemAction("publish", {
        summary: "Publish a library segment to running orders",
        description:
          "Publishes the segment's current version to up to 50 running orders of its org through app.publish_library_segment (422 `segment_publish_runs` otherwise), one transaction locking them in id order. In each, an older copy whose cues are all uncalled and none an artist's set time is replaced in place with the current cues and calls; local edits to those cues, custom values included, are lost. Needs show.run_of_show.write on every running order. Answers one outcome per copy.",
        body: z
          .object({
            run_of_show_ids: z
              .array(fields.uuid("Running order."))
              .min(1)
              .max(50)
              .meta({ description: "Running orders to publish to, 1 to 50." }),
          })
          .meta({
            id: "SegmentPublishRequest",
            description: "Running orders to publish the segment to.",
          }),
        response: PublishResults,
        rpc: "publish_library_segment",
      }),
    ],
  }),
  resource("Show", "/segment-library-cues", SegmentLibraryCue, { label: "library cue" }),
  resource("Show", "/segment-library-cue-calls", SegmentLibraryCueCall, {
    label: "library cue call",
  }),
  resource("Show", "/run-segment-instances", RunSegmentInstance, {
    verbs: ["list", "get"],
    label: "segment copy",
  }),
];

export const segmentLibraryCapabilities: Readonly<Record<string, CapabilityRule>> = {
  segmentLibrary: {
    read: "show.run_of_show.read",
    write: "show.run_of_show.write",
    actions: { insertIntoRun: "show.run_of_show.read", publish: "show.run_of_show.read" },
  },
  segmentLibraryCues: { read: "show.run_of_show.read", write: "show.run_of_show.write" },
  segmentLibraryCueCalls: { read: "show.run_of_show.read", write: "show.run_of_show.write" },
  runSegmentInstances: { read: "show.run_of_show.read" },
};

export const cueFieldAudienceResources: readonly ResourceSpec[] = [
  resource("Platform", "/cue-field-audiences", CueFieldAudience, {
    verbs: ["list", "create", "delete"],
    label: "cue field audience",
  }),
];

export const cueFieldAudienceCapabilities: Readonly<Record<string, CapabilityRule>> = {
  cueFieldAudiences: { read: "org.settings.read", write: "org.custom_fields.write" },
};

export const ShowChannelStatus = z
  .object({
    channel_exists: fields.bool("The project has a live show channel.", true),
    conversation_id: orNull(fields.uuid("Its conversation, only for a member of it.")),
    am_member: fields.bool("The caller is in the channel.", true),
    can_join: fields.bool(
      "The caller may join: a reader of the running order who is not a Client.",
      false,
    ),
    can_open: fields.bool(
      "The caller may open it: no channel yet and show.run_of_show.write.",
      false,
    ),
  })
  .meta({
    id: "ShowChannelStatus",
    description: "What the show channel panel may offer the caller.",
  });

const ShowChannel = z
  .object({ conversation_id: fields.uuid("The show channel's conversation.") })
  .meta({ id: "ShowChannelConversation", description: "A project's show channel conversation." });

const projectBody = (id: string) =>
  z
    .object({ project_id: fields.ref("project of the show channel") })
    .meta({ id, description: "The project whose show channel to use." });

/** Show channel actions on Workforce groups (2922, ADR 0142 decision 9): Clients are never in the channel. */
export const showChannelActions = [
  collectionAction("openShowChannel", {
    segment: "open-show-channel",
    summary: "Open a project's show channel",
    description:
      "Opens the project's show channel through app.open_show_channel and answers its conversation: a Project group named for the project (after `name_prefix`, Show channel by default), with the caller as Owner and the project's members who can read its running orders, less anyone engaged as Client. A project has one live show channel; opening again answers it. Needs membership of the project's org and show.run_of_show.write on the project.",
    body: z
      .object({
        project_id: fields.ref("project of the show channel"),
        name_prefix: fields
          .text(
            "What the channel's name starts with, before a middle dot and the project's name, in the opener's language. Defaults to Show channel.",
            "Canal del show",
            60,
          )
          .optional(),
        description: fields
          .text(
            "What the channel is for, in the opener's language. Defaults to the en-US description.",
            "Canal del show: el chat del equipo junto al cue en curso.",
            2000,
          )
          .optional(),
      })
      .meta({
        id: "ShowChannelOpenRequest",
        description:
          "The project whose show channel to open, and optionally its name prefix and description.",
      }),
    response: ShowChannel,
    rpc: "open_show_channel",
  }),
  collectionAction("joinShowChannel", {
    segment: "join-show-channel",
    summary: "Join a project's show channel",
    description:
      "Adds the caller to the project's live show channel through app.join_show_channel. Needs show.run_of_show.read on the project; anyone engaged as Client is refused (422 `show_channel_client`).",
    body: projectBody("ShowChannelJoinRequest"),
    response: ShowChannel,
    rpc: "join_show_channel",
  }),
  collectionQuery("showChannelStatus", {
    segment: "show-channel-status",
    summary: "Read what the show channel panel may offer",
    description:
      "Answers through app.show_channel_status whether the project has a live show channel, its conversation (only for a member), and whether the caller is in it, may join it or may open it. Group visibility hides a group from people outside it, so the panel asks here.",
    query: z.object({ project_id: fields.ref("project of the show channel") }),
    response: ShowChannelStatus,
    rpc: "show_channel_status",
  }),
] as const;
