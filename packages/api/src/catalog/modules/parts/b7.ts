/**
 * B7 (RRR-231, migrations 2960 to 2965, ADR 0146): named and filtered calendar feeds, and the project wrap-up's
 * debrief. Additive only (Section 10.1): the frozen /calendar-feeds operations and the CalendarFeed component are
 * unchanged; a feed's configuration has its own item action and query. catalog/modules/platform.ts and
 * catalog/modules/projects.ts spread these; handlers/parts/b7.ts serves them.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { editDefinition, orNull } from "../../correct.ts";
import { collectionAction, itemAction, itemQuery, resource } from "../../define.ts";
import type { ActionSpec, ResourceSpec } from "../../types.ts";

const SOURCES = ["Shifts", "Meetings", "Milestones", "Deadlines", "Cues"] as const;
const CALL_KINDS = ["Audio", "Lighting", "Video", "Special Effects", "Stage"] as const;

const feedName = orNull(
  fields.text(
    "Name of the feed and of the subscribed calendar; null for the default name.",
    "Lighting crew",
    80,
  ),
);
const feedSources = orNull(
  z
    .array(z.enum(SOURCES).meta({ description: "What the feed shows.", example: "Cues" }))
    .min(1)
    .max(5)
    .meta({
      description:
        "What the feed shows, each once; null for the default set (shifts, meetings, milestones and deadlines). Cues only on a project feed.",
      example: ["Shifts", "Cues"],
    }),
);

/** A project feed's audience: named people, one team or one department (2961). */
const FeedAudience = orNull(
  z
    .object({
      kind: z
        .enum(["people", "team", "department"])
        .meta({ description: "Who the feed follows.", example: "team" }),
      person_ids: z
        .array(fields.ref("person in the audience"))
        .max(50)
        .optional()
        .meta({ description: "With kind people: 1 to 50 members of the feed's org." }),
      team_id: fields.ref("team the feed follows").optional(),
      department_code: z
        .string()
        .regex(/^[0-9]000$/)
        .optional()
        .meta({ description: "With kind department: a canon department code.", example: "5000" }),
    })
    .meta({
      id: "CalendarFeedAudience",
      description:
        "A project feed's audience: only these people's, this team's or this department's shifts and records, never more than the feed's owner may see.",
    }),
);

const cueCallKind = orNull(
  z.enum(CALL_KINDS).meta({
    description:
      "Show department filter: only cues with this department's call, and its instruction.",
    example: "Lighting",
  }),
);

/** The configuration of a member or project feed (2961). */
export const CalendarFeedConfiguration = z
  .object({
    calendar_feed_id: fields.ref("calendar feed"),
    name: feedName,
    sources: feedSources,
    audience: FeedAudience,
    cue_call_kind: cueCallKind,
  })
  .meta({
    id: "CalendarFeedConfiguration",
    description:
      "A calendar feed's name, content sources, audience and show department (ADR 0146). A member feed takes only a name and sources without Cues.",
  });

const CalendarFeedConfigureRequest = z
  .object({
    name: feedName.optional(),
    sources: feedSources.optional(),
    audience: FeedAudience.optional(),
    cue_call_kind: cueCallKind.optional(),
  })
  .meta({
    id: "CalendarFeedConfigureRequest",
    description:
      "The whole configuration of a feed; a field left out is cleared. Refusals answer 422 with their rule: calendar_feed_name, calendar_feed_filter_scope, calendar_feed_audience, calendar_feed_people_limit and calendar_feed_sources.",
  });

const PersonCalendarFeedConfiguration = z
  .object({ calendar_feed_id: fields.ref("calendar feed"), name: feedName, sources: feedSources })
  .meta({
    id: "PersonCalendarFeedConfiguration",
    description: "A personal feed's name and content sources (ADR 0146).",
  });

const PersonCalendarFeedConfigureRequest = z
  .object({ name: feedName.optional(), sources: feedSources.optional() })
  .meta({
    id: "PersonCalendarFeedConfigureRequest",
    description:
      "The name and sources of a personal feed; a field left out is cleared. Refusals answer 422: calendar_feed_name and calendar_feed_sources.",
  });

export const b7Actions: Readonly<Record<string, readonly ActionSpec[]>> = {
  calendarFeeds: [
    itemAction("configure", {
      summary: "Configure a calendar feed",
      description:
        "Replaces the name, sources, audience and show department of one of the caller's live feeds (app.configure_calendar_feed). The subscription URL stays. Another member's or a revoked feed is not found.",
      body: CalendarFeedConfigureRequest,
      response: CalendarFeedConfiguration,
      rpc: "app.configure_calendar_feed",
    }),
    itemQuery("configuration", {
      summary: "Read a calendar feed's configuration",
      description:
        "The name, sources, audience and show department of one of the caller's live feeds. Another member's feed is not found.",
      response: CalendarFeedConfiguration,
    }),
  ],
  personCalendarFeeds: [
    itemAction("configure", {
      summary: "Configure a personal calendar feed",
      description:
        "Replaces the name and sources of one of the caller's own live feeds (app.configure_person_calendar_feed). The subscription URL stays.",
      body: PersonCalendarFeedConfigureRequest,
      response: PersonCalendarFeedConfiguration,
      rpc: "app.configure_person_calendar_feed",
    }),
    itemQuery("configuration", {
      summary: "Read a personal calendar feed's configuration",
      description: "The name and sources of one of the caller's own live feeds.",
      response: PersonCalendarFeedConfiguration,
    }),
  ],
};

export const b7PlatformCapabilities: Readonly<Record<string, CapabilityRule>> = {
  calendarFeeds: {
    actions: { configure: "me.calendar_feeds.write", configuration: "me.calendar_feeds.write" },
  },
  personCalendarFeeds: {
    actions: { configure: "me.calendar_feeds.write", configuration: "me.calendar_feeds.write" },
  },
};

// Project wrap-up ------------------------------------------------------------------------------------------------------

const audited = (def: Parameters<typeof editDefinition>[0]) =>
  editDefinition(def, { nullable: ["created_by", "updated_by"] });

const ProjectDebrief = audited(
  defineResource({
    name: "ProjectDebrief",
    table: "app.project_debriefs",
    description:
      "The debrief of a project's wrap-up (2965, ADR 0146): one live debrief per project, started and saved by projectDebriefs.save, completed once and reopened when it needs a change. Its points are project-debrief-items; its management summary prints on the wrap-up report for readers of every fact it is drafted from.",
    fields: {
      project_id: fields.ref("project the debrief wraps up"),
      completed_at: orNull(
        fields.instant("When the debrief was completed; points and summary lock until reopened."),
      ),
      completed_by: orNull(fields.ref("person who completed the debrief")),
    },
    serverSet: ["project_id", "completed_at", "completed_by"],
  }),
);

const ProjectDebriefItem = audited(
  defineResource({
    name: "ProjectDebriefItem",
    table: "app.project_debrief_items",
    description:
      "A point of a project debrief (2965): an area, Went Well, To Improve or Action, the point, and an owner for an Action only. Changes are refused while the debrief is completed (debrief_completed: 422); a deleted point is in Trash.",
    immutable: ["debrief_id"],
    fields: {
      debrief_id: fields.ref("debrief the point belongs to"),
      area: z
        .enum([
          "Schedule",
          "Budget",
          "Safety",
          "Audience",
          "Sustainability",
          "Crew",
          "Vendors",
          "Other",
        ])
        .meta({ description: "Area of the project the point is about.", example: "Safety" }),
      item_kind: z
        .enum(["Went Well", "To Improve", "Action"])
        .meta({ description: "Kind of point.", example: "Action" }),
      body: fields.text("The point.", "Add a second spotter on the downstage truss.", 2000),
      position: fields.int("Order in the debrief, from 1; the next free one when omitted.", 1, 1),
      owner_membership_id: orNull(
        fields.ref("member who owns an Action; only Actions have an owner"),
      ),
    },
  }),
);

const ProjectDebriefSaveRequest = z
  .object({
    project_id: fields.ref("project whose debrief to start or save"),
    management_summary: orNull(
      z.string().max(4000).meta({
        description:
          "The management summary: text to save it, blank to clear it, null or left out to leave it as it is.",
        example: "Delivered on budget; attendance 9,800 against a target of 9,000.",
      }),
    ).optional(),
    ai_request_id: orNull(
      fields.ref(
        "the caller's own Answered Aurora summaries request about this project the summary was drafted from (debrief_ai_request: 422 otherwise)",
      ),
    ).optional(),
  })
  .meta({
    id: "ProjectDebriefSaveRequest",
    description:
      "Starts the project's debrief when there is none and saves its management summary. Refusals answer 422: debrief_completed, debrief_ai_request and debrief_summary.",
  });

export const b7ProjectResources: readonly ResourceSpec[] = [
  resource("Projects", "/project-debriefs", ProjectDebrief, {
    verbs: ["list", "get"],
    actions: [
      collectionAction("save", {
        summary: "Start or save a project debrief",
        description:
          "Creates the project's debrief when there is none and saves its management summary (app.save_project_debrief). Answers the debrief.",
        body: ProjectDebriefSaveRequest,
        rpc: "app.save_project_debrief",
      }),
      itemAction("complete", {
        summary: "Complete a project debrief",
        description:
          "Stamps completion once (app.complete_project_debrief); points and the summary lock until it is reopened. An already completed debrief answers debrief_completed (422).",
        rpc: "app.complete_project_debrief",
      }),
      itemAction("reopen", {
        summary: "Reopen a project debrief",
        description:
          "Clears completion (app.reopen_project_debrief) so the points and summary can change again.",
        rpc: "app.reopen_project_debrief",
      }),
    ],
  }),
  resource("Projects", "/project-debrief-items", ProjectDebriefItem),
];

const debriefRule: CapabilityRule = {
  read: "projects.project.read",
  write: "projects.project.write",
};

export const b7ProjectCapabilities: Readonly<Record<string, CapabilityRule>> = {
  projectDebriefs: {
    ...debriefRule,
    actions: {
      save: "projects.project.write",
      complete: "projects.project.write",
      reopen: "projects.project.write",
    },
  },
  projectDebriefItems: debriefRule,
};
