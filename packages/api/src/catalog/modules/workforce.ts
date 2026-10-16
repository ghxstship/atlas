/**
 * Workforce operations (A29, Section 4.9; migrations 0800 to 0807 and 1010), all additive: group
 * spaces and chat, the feed with polls, pulse surveys and recognition, events, the form builder,
 * training and the handbook, the help desk, site operations (occupancy, weather, door check-in,
 * lost and found), the directory and the Assistant source search. Every shape is the table's own
 * columns. Writes the database guards through RPCs are actions on the resource; refusals answer
 * 422 with the rule the database named.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { orNull } from "../correct.ts";
import { collectionAction, collectionQuery, itemAction, itemQuery, resource } from "../define.ts";

// Shared pieces ------------------------------------------------------------------------------------

const label = (values: readonly [string, ...string[]], description: string) =>
  z.enum(values).meta({ description, example: values[0] });

/** The audit columns of a new resource: nullable, because seed and system writes have no person. */
const AUDIT = {
  created_by: orNull(
    fields.uuid("Person who created the row; null for seed, platform or system writes."),
  ),
  updated_by: orNull(
    fields.uuid("Person who last updated the row; null for seed, platform or system writes."),
  ),
};
const AUDIT_SET = ["created_by", "updated_by"] as const;

const AudienceKind = label(
  ["Organization", "Project", "Team", "Role", "Group"],
  "Who the row reaches.",
);
const AUDIENCE = {
  audience_kind: AudienceKind,
  project_id: orNull(fields.ref("project audience, or the project the row belongs to")),
  team_id: orNull(fields.ref("team audience")),
  role_id: orNull(fields.ref("org role audience")),
  group_id: orNull(fields.ref("group audience, including department groups")),
};

const reasonBody = (id: string, description: string) =>
  z
    .object({
      reason: z
        .string()
        .min(1)
        .max(500)
        .meta({ description, example: "Posted to the wrong project." }),
    })
    .meta({ id, description: "A reason for the change." });

const transition = (
  id: string,
  states: readonly [string, ...string[]],
  example: [string, string],
) =>
  z
    .object({
      expected_state: z
        .enum(states)
        .meta({ description: "The state the caller believes the row is in.", example: example[0] }),
      to_state: z.enum(states).meta({ description: "Target state.", example: example[1] }),
      reason: z
        .string()
        .min(1)
        .max(500)
        .meta({ description: "Why the state changes.", example: "Ready to go." }),
    })
    .meta({ id, description: "Request to move a lifecycle to another state." });

const Ledger = z
  .object({ ledger_id: fields.uuid("The state transition ledger entry written.") })
  .meta({ id: "WorkforceLedgerEntry", description: "The ledger entry a lifecycle move wrote." });

// Groups and chat ------------------------------------------------------------------------------------

const Group = defineResource({
  name: "WorkforceGroup",
  table: "app.groups",
  description:
    "A group space by department, project, crew or custom audience, with its own chat and files.",
  immutable: ["group_kind", "project_id"],
  serverSet: ["archived_at", ...AUDIT_SET],
  fields: {
    name: fields.text("Group name, unique in the org.", "Rigging Crew", 120),
    group_kind: label(["Department", "Project", "Crew", "Custom"], "What the group gathers."),
    project_id: orNull(fields.ref("project a Project group gathers")),
    description: orNull(fields.text("What the group is for.", "Everyone flying points.", 2000)),
    archived_at: orNull(fields.instant("When the group was archived.")),
    ...AUDIT,
  },
});

const GroupMember = defineResource({
  name: "WorkforceGroupMember",
  table: "app.group_members",
  description:
    "A member of a group space. Deleting removes the member, who also leaves the group conversation.",
  immutable: ["group_id", "membership_id"],
  serverSet: [...AUDIT_SET],
  fields: {
    group_id: fields.ref("group"),
    membership_id: fields.ref("member of the org in the group"),
    group_role: label(["Member", "Owner"], "Owners add and remove members."),
    ...AUDIT,
  },
});

const Conversation = defineResource({
  name: "Conversation",
  table: "app.conversations",
  description:
    "A chat conversation: one-to-one between two members, or the conversation of a group.",
  serverSet: ["conversation_kind", "group_id", "direct_key", "last_message_at", ...AUDIT_SET],
  fields: {
    conversation_kind: label(["Direct", "Group"], "Direct or Group."),
    group_id: orNull(fields.ref("group whose conversation this is")),
    direct_key: orNull(
      fields.text(
        "The two membership ids of a Direct conversation, sorted and joined by a colon.",
        "a:b",
        80,
      ),
    ),
    last_message_at: orNull(fields.instant("When the latest message was sent.")),
    ...AUDIT,
  },
});

const ChatMessage = defineResource({
  name: "ChatMessage",
  table: "app.chat_messages",
  description: "A chat message. Photos, files and voice notes are attachments on the message.",
  immutable: ["conversation_id", "message_kind", "language"],
  serverSet: ["author_membership_id", "edited_at", ...AUDIT_SET],
  fields: {
    conversation_id: fields.ref("conversation"),
    author_membership_id: fields.ref("member who sent it"),
    message_kind: label(["Text", "Photo", "File", "Voice"], "What the message carries."),
    body: orNull(
      fields.text(
        "Message text; optional for a photo, file or voice note.",
        "Points are up on stage left.",
        4000,
      ),
    ),
    language: orNull(fields.localeTag("Language the author wrote in.")),
    edited_at: orNull(fields.instant("When the author last edited the text.")),
    ...AUDIT,
  },
});

const ReadReceipt = z
  .object({
    membership_id: fields.uuid("Member of the conversation."),
    full_name: fields.text("Their name.", "Carol Nguyen"),
    last_read_at: fields.instant("When they last read it.").nullable(),
  })
  .meta({
    id: "ConversationReadReceipt",
    description: "When another member last read the conversation.",
  });

const DirectoryEntry = defineResource({
  name: "DirectoryEntry",
  table: "app.workforce_directory",
  base: "view",
  description:
    "A member in the org directory: profile basics they share with their network, roles, whether they are on site now (clocked in inside a geofence), the work phone they chose to share and their recognition count when they consented.",
  fields: {
    membership_id: fields.uuid("Membership."),
    person_id: fields.uuid("Person."),
    full_name: fields.text("Name.", "Frank Adeyemi"),
    preferred_name: orNull(fields.text("Preferred name.", "Frankie")),
    headline: orNull(fields.text("Profile headline.", "Head rigger")),
    photo_path: orNull(fields.text("Profile photo storage path.", "profiles/p1.jpg", 500)),
    role_names: z.array(z.string()).meta({ description: "Org roles held.", example: ["Field"] }),
    on_site_now: fields.bool("Whether they are clocked in inside a geofence now.", true),
    on_site_project_id: orNull(fields.ref("project they are on site for")),
    on_site_since: orNull(fields.instant("When they clocked in.")),
    work_phone: orNull(
      fields.text("Work phone they shared for one-tap calls.", "+1 305 555 0199", 32),
    ),
    recognition_count: orNull(fields.int("Times recognized, shown only with their consent.", 3)),
  },
});

// Feed, polls, surveys, recognition ---------------------------------------------------------------------

const FeedPost = defineResource({
  name: "FeedPost",
  table: "app.feed_posts",
  description:
    "A feed post for an audience: an announcement, update, poll or recognition, with pinning, required acknowledgment, reaction and comment switches and a publish time.",
  immutable: [
    "post_kind",
    "title",
    "body",
    "audience_kind",
    "project_id",
    "team_id",
    "role_id",
    "group_id",
    "requires_acknowledgment",
  ],
  serverSet: [
    "author_membership_id",
    "pinned_at",
    "notified_at",
    "hidden_at",
    "hidden_reason",
    ...AUDIT_SET,
  ],
  fields: {
    post_kind: label(
      ["Announcement", "Update", "Poll", "Recognition"],
      "Post kind; Poll posts come from the createPoll action, Recognition posts from recognitions.",
    ),
    title: orNull(fields.text("Optional headline.", "Wristband change", 200)),
    body: fields.text("Post text.", "Wristbands change color on Friday.", 10000),
    ...AUDIENCE,
    author_membership_id: orNull(fields.ref("member who wrote the post")),
    pinned_at: orNull(fields.instant("When the post was pinned; null when not pinned.")),
    requires_acknowledgment: fields.bool(
      "Whether every member of the audience must acknowledge it.",
      false,
    ),
    reactions_enabled: fields.bool("Whether members can react.", true),
    comments_enabled: fields.bool("Whether members can comment.", true),
    publish_at: fields.instant("When the post appears; a future time schedules it."),
    notified_at: orNull(fields.instant("When the audience was notified.")),
    hidden_at: orNull(fields.instant("When the post was hidden.")),
    hidden_reason: orNull(fields.text("Why it was hidden.", "Posted to the wrong project.", 500)),
    ...AUDIT,
  },
});

const PollPostRequest = z
  .object({
    body: z
      .string()
      .min(1)
      .max(10000)
      .meta({ description: "Post text.", example: "Pick the crew meal." }),
    title: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .meta({ description: "Optional headline.", example: "Crew meal" }),
    audience_kind: AudienceKind.optional(),
    project_id: fields.uuid("Project audience.").optional(),
    team_id: fields.uuid("Team audience.").optional(),
    role_id: fields.uuid("Role audience.").optional(),
    group_id: fields.uuid("Group audience.").optional(),
    question: z
      .string()
      .min(1)
      .max(300)
      .meta({ description: "Poll question.", example: "Which crew meal on Saturday?" }),
    options: z
      .array(z.string().min(1).max(120))
      .min(2)
      .max(10)
      .meta({ description: "2 to 10 options.", example: ["Tacos", "Pasta"] }),
    allows_multiple: z
      .boolean()
      .optional()
      .meta({ description: "Whether members may pick several.", example: false }),
    closes_at: z.iso
      .datetime({ offset: true })
      .optional()
      .meta({ description: "When voting closes.", example: "2026-10-08T14:30:00Z" }),
  })
  .meta({ id: "PollPostRequest", description: "A poll posted to the feed." });

const AcknowledgmentStatus = z
  .object({
    membership_id: fields.uuid("Member of the audience."),
    person_id: fields.uuid("Person."),
    full_name: fields.text("Name.", "Frank Adeyemi"),
    acknowledged_at: fields.instant("When they acknowledged.").nullable(),
  })
  .meta({
    id: "FeedAcknowledgmentStatus",
    description: "One audience member and when they acknowledged the post.",
  });

const Poll = defineResource({
  name: "Poll",
  table: "app.polls",
  description: "A quick poll in the feed, attached to a post of kind Poll.",
  serverSet: ["feed_post_id", "question", "allows_multiple", "closes_at", ...AUDIT_SET],
  fields: {
    feed_post_id: fields.ref("feed post"),
    question: fields.text("Question.", "Which crew meal on Saturday?"),
    allows_multiple: fields.bool("Whether members may pick several options.", false),
    closes_at: orNull(fields.instant("When voting closes.")),
    ...AUDIT,
  },
});

const PollResult = z
  .object({
    poll_option_id: fields.uuid("Option."),
    option_position: fields.int("Order, from 1.", 1, 1),
    label: fields.text("Option text.", "Tacos"),
    votes: fields.int("Votes for the option.", 12),
    voters: fields.int("Members who voted in the poll.", 20),
  })
  .meta({ id: "PollResult", description: "Votes for one poll option." });

const Survey = defineResource({
  name: "Survey",
  table: "app.surveys",
  description:
    "A pulse survey for an audience, anonymous by default, with results only once the minimum number of responses is met.",
  serverSet: ["author_membership_id", "survey_state", ...AUDIT_SET],
  fields: {
    title: fields.text("Survey title.", "Load-in pulse", 200),
    description: orNull(
      fields.text("What the survey asks about.", "Tell us how the load-in felt.", 2000),
    ),
    ...AUDIENCE,
    author_membership_id: orNull(fields.ref("member who wrote the survey")),
    is_anonymous: fields.bool("Whether answers are stored with no respondent.", true),
    min_responses: fields.int("Responses needed before results show.", 5, 3),
    survey_state: label(["Draft", "Open", "Closed"], "Draft, Open or Closed."),
    closes_at: orNull(fields.instant("When responses stop.")),
    ...AUDIT,
  },
});

const SurveyQuestion = defineResource({
  name: "SurveyQuestion",
  table: "app.survey_questions",
  description: "A question of a pulse survey, in order.",
  serverSet: [
    "survey_id",
    "position",
    "prompt",
    "question_kind",
    "choices",
    "scale_max",
    "is_required",
    ...AUDIT_SET,
  ],
  fields: {
    survey_id: fields.ref("survey"),
    position: fields.int("Order, from 1.", 1, 1),
    prompt: fields.text("Question text.", "How safe did the load-in feel?", 500),
    question_kind: label(["Scale", "Choice", "Text"], "Question kind."),
    choices: z
      .array(z.string())
      .nullable()
      .meta({ description: "Options of a Choice question.", example: ["Morning", "Night"] }),
    scale_max: orNull(fields.int("Top of a Scale question: 5 or 10.", 5, 5)),
    is_required: fields.bool("Whether a response must answer it.", true),
    ...AUDIT,
  },
});

const SurveyDraftRequest = z
  .object({
    title: z
      .string()
      .min(1)
      .max(200)
      .meta({ description: "Survey title.", example: "Load-in pulse" }),
    description: z
      .string()
      .max(2000)
      .optional()
      .meta({ description: "What the survey asks about.", example: "How did it go?" }),
    audience_kind: AudienceKind.optional(),
    project_id: fields.uuid("Project audience.").optional(),
    team_id: fields.uuid("Team audience.").optional(),
    role_id: fields.uuid("Role audience.").optional(),
    group_id: fields.uuid("Group audience.").optional(),
    is_anonymous: z
      .boolean()
      .optional()
      .meta({ description: "Anonymous by default.", example: true }),
    min_responses: z
      .number()
      .int()
      .min(3)
      .max(1000)
      .optional()
      .meta({ description: "Responses before results show; 5 by default.", example: 5 }),
    closes_at: z.iso
      .datetime({ offset: true })
      .optional()
      .meta({ description: "When responses stop.", example: "2026-10-08T14:30:00Z" }),
    questions: z
      .array(
        z.object({
          prompt: z
            .string()
            .min(1)
            .max(500)
            .meta({ description: "Question text.", example: "How safe did it feel?" }),
          kind: z
            .enum(["Scale", "Choice", "Text"])
            .meta({ description: "Question kind.", example: "Scale" }),
          choices: z
            .array(z.string().min(1))
            .min(2)
            .max(10)
            .optional()
            .meta({ description: "Choice options.", example: ["A", "B"] }),
          scale_max: z
            .union([z.literal(5), z.literal(10)])
            .optional()
            .meta({ description: "Scale top.", example: 5 }),
          required: z
            .boolean()
            .optional()
            .meta({ description: "Required; true by default.", example: true }),
        }),
      )
      .min(1)
      .max(50)
      .meta({
        description: "1 to 50 questions in order.",
        example: [{ prompt: "How safe did it feel?", kind: "Scale" }],
      }),
  })
  .meta({ id: "SurveyDraftRequest", description: "A survey drafted with its questions." });

const SurveyResults = z
  .object({
    survey_id: fields.uuid("Survey."),
    responses: fields.int("Responses so far.", 12),
    min_responses: fields.int("Responses needed before results show.", 5),
    threshold_met: fields.bool("Whether results show.", true),
    audience: fields.int("Members in the audience.", 40),
    questions: z
      .array(
        z.object({
          question_id: fields.uuid("Question."),
          position: fields.int("Order.", 1),
          prompt: fields.text("Question text.", "How safe did it feel?"),
          kind: z
            .enum(["Scale", "Choice", "Text"])
            .meta({ description: "Question kind.", example: "Scale" }),
          scale_max: z.number().int().nullable().meta({ description: "Scale top.", example: 5 }),
          answered: fields.int("Answers given.", 12),
          average: z
            .number()
            .nullable()
            .meta({ description: "Average of a Scale question.", example: 4.2 }),
          counts: z
            .record(z.string(), z.number())
            .nullable()
            .meta({
              description: "Answers per choice or scale point.",
              example: { "4": 7, "5": 5 },
            }),
          texts: z
            .array(z.string())
            .nullable()
            .meta({
              description: "Text answers, sorted, not in arrival order.",
              example: ["More water at the dock."],
            }),
        }),
      )
      .meta({ description: "Per question results; empty below the threshold.", example: [] }),
  })
  .meta({ id: "SurveyResults", description: "Results of a pulse survey." });

const Recognition = defineResource({
  name: "Recognition",
  table: "app.recognitions",
  description:
    "A shout-out from one member to another, tied to a project or shift and posted to the feed. No points currency.",
  serverSet: ["from_membership_id", "feed_post_id", ...AUDIT_SET],
  fields: {
    from_membership_id: fields.ref("member who gave the recognition"),
    to_membership_id: fields.ref("member recognized"),
    project_id: orNull(fields.ref("project the recognition is for")),
    shift_id: orNull(fields.ref("shift the recognition is for")),
    message: fields.text("What they did well.", "Re-rigged the truss in record time.", 1000),
    feed_post_id: orNull(fields.ref("recognition post in the feed")),
    ...AUDIT,
  },
});

// Events ---------------------------------------------------------------------------------------------

const WorkforceEvent = defineResource({
  name: "WorkforceEvent",
  table: "app.workforce_events",
  description:
    "A briefing, crew call or meeting for an audience, with RSVP, location, agenda and check-in.",
  immutable: ["audience_kind", "team_id", "role_id", "group_id"],
  serverSet: ["organizer_membership_id", "canceled_at", "cancel_reason", ...AUDIT_SET],
  fields: {
    event_kind: label(["Briefing", "Crew Call", "Meeting"], "Event kind."),
    title: fields.text("Event title.", "Load-in crew call", 200),
    agenda: orNull(fields.longText("Agenda, in order.", "1. Safety brief. 2. Assignments.")),
    location: orNull(fields.text("Where to meet.", "Dock door 3", 300)),
    venue_id: orNull(fields.ref("venue")),
    space_id: orNull(fields.ref("space within the venue")),
    ...AUDIENCE,
    organizer_membership_id: orNull(fields.ref("member who organizes the event")),
    starts_at: fields.instant("Start."),
    ends_at: fields.instant("End, at most seven days after the start."),
    rsvp_required: fields.bool("Whether invitees are asked to RSVP.", true),
    canceled_at: orNull(fields.instant("When the event was canceled.")),
    cancel_reason: orNull(fields.text("Why it was canceled.", "Dock closed for repairs.", 500)),
    ...AUDIT,
  },
});

const EventRsvp = defineResource({
  name: "EventRsvp",
  table: "app.event_rsvps",
  description: "An invitee's RSVP to an event.",
  serverSet: ["workforce_event_id", "membership_id", "response", "responded_at", ...AUDIT_SET],
  fields: {
    workforce_event_id: fields.ref("event"),
    membership_id: fields.ref("invitee"),
    response: label(["Going", "Maybe", "Declined"], "RSVP answer."),
    responded_at: fields.instant("When they last answered."),
    ...AUDIT,
  },
});

const EventCheckIn = defineResource({
  name: "EventCheckIn",
  table: "app.event_check_ins",
  description: "Attendance of an event, one per attendee.",
  serverSet: [
    "workforce_event_id",
    "membership_id",
    "check_in_method",
    "checked_in_at",
    ...AUDIT_SET,
  ],
  fields: {
    workforce_event_id: fields.ref("event"),
    membership_id: fields.ref("attendee"),
    check_in_method: label(["Self", "Organizer", "Scan"], "How they were checked in."),
    checked_in_at: fields.instant("When they checked in."),
    ...AUDIT,
  },
});

// Forms --------------------------------------------------------------------------------------------------

const FormFieldSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/)
      .meta({ description: "Field key.", example: "hoist_ok" }),
    label: z.string().min(1).max(200).meta({ description: "Label.", example: "Hoist inspected" }),
    kind: z
      .enum(["text", "long_text", "number", "yes_no", "choice", "multi_choice", "date", "photo"])
      .meta({ description: "Field kind.", example: "yes_no" }),
    required: z
      .boolean()
      .optional()
      .meta({ description: "Whether it must be answered when shown.", example: true }),
    choices: z
      .array(z.string())
      .optional()
      .meta({ description: "Choices of a choice field.", example: ["Light", "Heavy"] }),
    points: z
      .record(z.string(), z.number())
      .optional()
      .meta({ description: "Points per answer, for scoring.", example: { true: 2 } }),
    show_if: z
      .object({
        key: z.string().meta({ description: "Earlier field key.", example: "hoist_ok" }),
        equals: z
          .union([z.string(), z.number(), z.boolean()])
          .meta({ description: "Answer that shows the field.", example: false }),
      })
      .optional()
      .meta({ description: "Shows the field only when an earlier field has this answer." }),
  })
  .meta({ id: "FormField", description: "One field of a form." });

const FormTemplate = defineResource({
  name: "FormTemplate",
  table: "app.form_templates",
  description:
    "A no-code form with conditional fields, photos, GPS stamp, signature, scoring and approval routing. Project submissions become records of its canon kind and subtype.",
  serverSet: ["template_state", "current_version", ...AUDIT_SET],
  fields: {
    name: fields.text("Form name, unique in the org.", "Rigging pre-use check", 200),
    description: orNull(fields.text("When to fill it in.", "Before every lift.", 2000)),
    record_kind: fields.code("Canon record kind each project submission becomes.", "Inspection"),
    record_subtype: orNull(fields.code("Canon record subtype.", "Safety")),
    fields: z
      .array(FormFieldSchema)
      .min(1)
      .max(100)
      .meta({
        description: "Field definitions in order.",
        example: [{ key: "hoist_ok", label: "Hoist inspected", kind: "yes_no" }],
      }),
    requires_signature: fields.bool("Whether a submission must be signed.", true),
    requires_location: fields.bool("Whether a submission needs a GPS stamp.", true),
    pass_score: z
      .number()
      .min(0)
      .nullable()
      .optional()
      .meta({ description: "Score needed to pass; null when not scored to pass.", example: 2 }),
    approver_role_id: orNull(fields.ref("org role whose holders approve submissions")),
    template_state: label(["Draft", "Published", "Retired"], "Draft, Published or Retired."),
    current_version: fields.int("Latest published version; 0 before the first publish.", 1),
    ...AUDIT,
  },
});

const FormSubmission = defineResource({
  name: "FormSubmission",
  table: "app.form_submissions",
  description:
    "A submitted form: answers against one template version, score, GPS stamp, signature and approval.",
  serverSet: [
    "form_template_version_id",
    "record_id",
    "submitted_by_membership_id",
    "score",
    "max_score",
    "passed",
    "signed_at",
    "submission_state",
    "decided_by_membership_id",
    "decision_note",
    ...AUDIT_SET,
  ],
  fields: {
    form_template_id: fields.ref("form answered"),
    form_template_version_id: fields.ref("version answered"),
    project_id: orNull(fields.ref("project the submission belongs to")),
    record_id: orNull(fields.ref("record the project submission became")),
    submitted_by_membership_id: fields.ref("member who submitted"),
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
    latitude: orNull(fields.latitude()),
    longitude: orNull(fields.longitude()),
    accuracy_m: z
      .number()
      .min(0)
      .nullable()
      .optional()
      .meta({ description: "GPS accuracy in metres.", example: 8 }),
    signer_name: orNull(fields.text("Name of the signer.", "Frank Adeyemi", 200)),
    signature_path: orNull(
      fields.text("Signature image path in the field-media bucket.", "org/forms/sig.png", 500),
    ),
    signed_at: orNull(fields.instant("When it was signed.")),
    submission_state: label(["Submitted", "Approved", "Rejected", "Recorded"], "Submission state."),
    decided_by_membership_id: orNull(fields.ref("approver who decided")),
    decision_note: orNull(fields.text("Approver's note.", "Good to lift.", 1000)),
    ...AUDIT,
  },
});

// Training and handbook ------------------------------------------------------------------------------------

const TrainingCourse = defineResource({
  name: "TrainingCourse",
  table: "app.training_courses",
  description:
    "A short training course of lessons and quizzes with completion records and expiry, linked to a role, a certification and a gate criterion.",
  serverSet: ["course_state", ...AUDIT_SET],
  fields: {
    title: fields.text("Course title.", "Rigging basics", 200),
    summary: orNull(fields.text("What the course teaches.", "Slings and shackles.", 2000)),
    role_code: orNull(fields.code("Canon role trained for.", "5000.01.01")),
    certification_id: orNull(fields.ref("org certification a pass qualifies for")),
    gate_criterion_id: orNull(
      fields.code("Canon gate criterion the course helps satisfy.", "G3.CREW_TRAINED"),
    ),
    validity_days: orNull(fields.int("Days a pass stays current.", 365, 1)),
    pass_percent: fields.int("Quiz score needed to pass, in percent.", 80, 1),
    estimated_minutes: orNull(fields.int("Expected time.", 20, 1)),
    course_state: label(["Draft", "Published", "Retired"], "Course state."),
    ...AUDIT,
  },
});

const TrainingLesson = defineResource({
  name: "TrainingLesson",
  table: "app.training_lessons",
  description:
    "A lesson of a training course: a reading, a video or a quiz. Changes only while the course is a draft.",
  immutable: ["training_course_id", "lesson_kind"],
  serverSet: [...AUDIT_SET],
  fields: {
    training_course_id: fields.ref("course"),
    position: fields.int("Order, from 1.", 1, 1),
    title: fields.text("Lesson title.", "Slings", 200),
    lesson_kind: label(["Reading", "Video", "Quiz"], "Lesson kind."),
    body: orNull(fields.longText("Reading text or notes.", "Inspect every sling before use.")),
    video_url: orNull(fields.url("HTTPS address of the lesson video.")),
    ...AUDIT,
  },
});

const TrainingQuizQuestion = defineResource({
  name: "TrainingQuizQuestion",
  table: "app.training_quiz_questions",
  description:
    "A question of a quiz lesson; its correct option is a training quiz key that learners never read.",
  immutable: ["training_lesson_id"],
  serverSet: [...AUDIT_SET],
  fields: {
    training_lesson_id: fields.ref("quiz lesson"),
    position: fields.int("Order, from 1.", 1, 1),
    prompt: fields.text("Question text.", "What do you do before a lift?", 500),
    options: z
      .array(z.string())
      .min(2)
      .max(6)
      .meta({ description: "Answer options.", example: ["Inspect the sling", "Skip it"] }),
    ...AUDIT,
  },
});

const TrainingQuizKey = defineResource({
  name: "TrainingQuizKey",
  table: "app.training_quiz_keys",
  description: "The correct option of a quiz question. Only course editors read it.",
  immutable: ["training_quiz_question_id"],
  serverSet: [...AUDIT_SET],
  fields: {
    training_quiz_question_id: fields.ref("quiz question"),
    correct_option: fields.int("Correct option, from 1.", 1, 1),
    ...AUDIT,
  },
});

const TrainingAssignment = defineResource({
  name: "TrainingAssignment",
  table: "app.training_assignments",
  description: "A course assigned to a member with a due date. Deleting withdraws it.",
  serverSet: [
    "training_course_id",
    "membership_id",
    "assigned_by_membership_id",
    "due_on",
    "reason",
    ...AUDIT_SET,
  ],
  fields: {
    training_course_id: fields.ref("course"),
    membership_id: fields.ref("learner"),
    assigned_by_membership_id: orNull(fields.ref("who assigned it")),
    due_on: orNull(fields.date("Day it is due.")),
    reason: orNull(fields.text("Why it was assigned.", "New riggers", 300)),
    ...AUDIT,
  },
});

const TrainingCompletion = defineResource({
  name: "TrainingCompletion",
  table: "app.training_completions",
  description:
    "A training attempt with its quiz score; a pass carries a certificate number and expiry.",
  serverSet: [
    "training_course_id",
    "membership_id",
    "score_percent",
    "passed",
    "completed_at",
    "expires_at",
    "certificate_number",
    "certification_holder_id",
    ...AUDIT_SET,
  ],
  fields: {
    training_course_id: fields.ref("course"),
    membership_id: fields.ref("learner"),
    score_percent: orNull(fields.int("Quiz score in percent.", 90)),
    passed: fields.bool("Whether the attempt passed.", true),
    completed_at: fields.instant("When the attempt finished."),
    expires_at: orNull(fields.instant("When the pass stops being current.")),
    certificate_number: orNull(fields.code("Completion certificate number.", "TRN-0001")),
    certification_holder_id: orNull(fields.ref("certification record a verifier issued")),
    ...AUDIT,
  },
});

const HandbookSection = defineResource({
  name: "HandbookSection",
  table: "app.handbook_sections",
  description: "A chapter of the org handbook.",
  serverSet: [...AUDIT_SET],
  fields: {
    name: fields.text("Section name.", "Site rules", 120),
    position: fields.int("Order.", 1, 1),
    ...AUDIT,
  },
});

const HandbookArticle = defineResource({
  name: "HandbookArticle",
  table: "app.handbook_articles",
  description:
    "A handbook or SOP article: versioned on publish, optionally a mandatory read acknowledged per version.",
  serverSet: ["article_state", "published_version", "published_at", ...AUDIT_SET],
  fields: {
    handbook_section_id: orNull(fields.ref("section")),
    title: fields.text("Title.", "Hearing protection", 200),
    body: fields.longText(
      "Working text; members read the published version.",
      "Wear hearing protection near the stacks.",
    ),
    is_mandatory: fields.bool("Whether every member must acknowledge the current version.", true),
    article_state: label(["Draft", "Published", "Archived"], "Article state."),
    published_version: fields.int("Latest published version.", 1),
    published_at: orNull(fields.instant("When the latest version was published.")),
    ...AUDIT,
  },
});

const KnowledgeSource = defineResource({
  name: "KnowledgeSource",
  table: "app.assistant_knowledge_sources",
  base: "view",
  description:
    "A published handbook article, SOP or training lesson matching a question, for the Assistant to cite (Section 4.7).",
  fields: {
    source_kind: label(["Handbook", "SOP", "Training"], "Source kind."),
    source_id: fields.uuid("Source row."),
    title: fields.text("Title.", "Hearing protection"),
    version: orNull(fields.int("Version cited.", 2)),
    excerpt: fields.longText("Matching excerpt.", "Wear hearing protection near the stacks."),
    route: fields.text(
      "Atlas route of the source.",
      "/northwind-live/knowledge/handbook?peek=x",
      500,
    ),
    rank: z.number().meta({ description: "Relevance.", example: 0.42 }),
  },
});

// Help desk -----------------------------------------------------------------------------------------------

const HelpDeskTeam = defineResource({
  name: "HelpDeskTeam",
  table: "app.help_desk_teams",
  description: "An internal team that answers help desk requests, with its first response target.",
  serverSet: ["archived_at", ...AUDIT_SET],
  fields: {
    name: fields.text("Team name.", "IT Desk", 120),
    team_kind: label(["Operations", "IT", "HR", "Facilities", "Other"], "Team kind."),
    description: orNull(fields.text("What the team helps with.", "Devices and accounts.", 1000)),
    first_response_hours: fields.int("Business hours to first response.", 8, 1),
    archived_at: orNull(fields.instant("When the team stopped taking requests.")),
    ...AUDIT,
  },
});

const HelpDeskTeamMember = defineResource({
  name: "HelpDeskTeamMember",
  table: "app.help_desk_team_members",
  description: "A member who answers a help desk team's requests. Deleting removes them.",
  immutable: ["help_desk_team_id", "membership_id"],
  serverSet: [...AUDIT_SET],
  fields: {
    help_desk_team_id: fields.ref("team"),
    membership_id: fields.ref("member"),
    ...AUDIT,
  },
});

const HelpDeskRequest = defineResource({
  name: "HelpDeskRequest",
  table: "app.support_tickets",
  description:
    "A help desk request: an Organization queue support ticket routed to an internal team, with assignment and response deadline.",
  serverSet: [
    "ticket_number",
    "ticket_state",
    "membership_id",
    "assignee_membership_id",
    "help_desk_response_due_at",
    "first_responded_at",
    ...AUDIT_SET,
  ],
  immutable: ["help_desk_team_id", "category", "severity", "subject", "body"],
  fields: {
    ticket_number: fields.code("Display number.", "SUP-0001"),
    help_desk_team_id: fields.ref("team the request is routed to"),
    category: label(
      ["Question", "Problem", "Access", "Billing", "Account", "Feature Request"],
      "What it is about.",
    ),
    severity: label(["Severity 3", "Severity 1", "Severity 2", "Severity 4"], "Severity."),
    subject: fields.text("One-line summary.", "Tablet will not sign in", 200),
    body: fields.longText(
      "What happened and what is needed.",
      "The dock tablet shows a blank screen.",
    ),
    ticket_state: label(["Open", "Waiting", "Resolved", "Closed"], "Request state."),
    membership_id: fields.ref("member who asked"),
    assignee_membership_id: orNull(fields.ref("team member it is assigned to")),
    help_desk_response_due_at: orNull(fields.instant("When the first response is due.")),
    first_responded_at: orNull(fields.instant("When the team first answered.")),
    ...AUDIT,
  },
});

const HelpDeskMessage = z
  .object({ message_id: fields.uuid("The message written.") })
  .meta({ id: "HelpDeskAnswer", description: "The message an answer wrote." });

// Site operations --------------------------------------------------------------------------------------------

const OccupancyCounter = defineResource({
  name: "OccupancyCounter",
  table: "app.occupancy_counters",
  description:
    "A live occupancy counter against the permitted occupant load, with alerts at 80, 90 and 100 percent.",
  serverSet: [
    "load_basis",
    "metric_domain",
    "permitted_load",
    "current_count",
    "alert_level_percent",
    "closed_at",
    ...AUDIT_SET,
  ],
  fields: {
    project_id: fields.ref("project"),
    space_id: orNull(fields.ref("space counted")),
    name: fields.text("Counter name.", "Main Floor", 120),
    load_basis: label(
      ["Occupant Load Factor", "Space Capacity", "Permit"],
      "Where the permitted load comes from.",
    ),
    metric_domain: orNull(fields.code("Bible metric domain of the load factor.", "capacity")),
    metric_item: orNull(fields.text("Bible occupant load factor.", "Assembly - standing space")),
    permitted_load: fields.int("Permitted occupant load.", 100, 1),
    current_count: fields.int("People inside now.", 82),
    alert_level_percent: fields.int("Highest alert level met: 0, 80, 90 or 100.", 80),
    closed_at: orNull(fields.instant("When counting stopped.")),
    ...AUDIT,
  },
});

const CounterCreateRequest = z
  .object({
    project_id: fields.uuid("Project."),
    name: z.string().min(1).max(120).meta({ description: "Counter name.", example: "Main Floor" }),
    space_id: fields.uuid("Space counted.").optional(),
    metric_item: z
      .string()
      .optional()
      .meta({
        description: "Bible occupant load factor sizing the space.",
        example: "Assembly - standing space",
      }),
    permitted_load: z
      .number()
      .int()
      .min(1)
      .optional()
      .meta({ description: "Permitted load from a permit.", example: 400 }),
  })
  .meta({
    id: "OccupancyCounterCreateRequest",
    description: "An occupancy counter sized by a permit, a load factor or the space capacity.",
  });

const WeatherThreshold = defineResource({
  name: "WeatherThreshold",
  table: "app.weather_thresholds",
  description:
    "A weather action threshold of a project: one value per hazard and level, with its emergency plan source.",
  immutable: ["project_id", "hazard", "alert_level", "unit", "comparison"],
  serverSet: [...AUDIT_SET],
  fields: {
    project_id: fields.ref("project"),
    hazard: label(["Wind", "Lightning", "Heat"], "Hazard."),
    alert_level: label(["Monitor", "Restrict", "Evacuate"], "Level."),
    threshold_value: z
      .number()
      .min(0)
      .max(200)
      .meta({ description: "Value that triggers the level.", example: 30 }),
    unit: label(
      ["mph", "mi", "F"],
      "Unit: mph for wind, mi for lightning distance, F for heat index.",
    ),
    comparison: label(
      ["At or Above", "At or Below"],
      "At or Above for wind and heat, At or Below for lightning.",
    ),
    source_note: fields.text("Where the value comes from.", "Emergency plan 4.2", 300),
    ...AUDIT,
  },
});

const WeatherAlertRole = defineResource({
  name: "WeatherAlertRole",
  table: "app.weather_alert_roles",
  description:
    "A canon role the emergency plan names for a weather level; people assigned it on the project are alerted.",
  immutable: ["project_id", "alert_level", "role_code"],
  serverSet: [...AUDIT_SET],
  fields: {
    project_id: fields.ref("project"),
    alert_level: label(["Monitor", "Restrict", "Evacuate"], "Level."),
    role_code: fields.code("Canon role notified.", "5000.01.01"),
    ...AUDIT,
  },
});

const WeatherReading = defineResource({
  name: "WeatherReading",
  table: "app.weather_readings",
  description: "A weather reading on site, in the hazard's unit.",
  serverSet: ["recorded_by_membership_id", ...AUDIT_SET],
  fields: {
    project_id: fields.ref("project"),
    hazard: label(["Wind", "Lightning", "Heat"], "Hazard."),
    reading_value: z.number().min(0).max(200).meta({ description: "Reading.", example: 33 }),
    observed_at: fields.instant("When it was observed."),
    recorded_by_membership_id: orNull(fields.ref("member who recorded it")),
    ...AUDIT,
  },
});

const WeatherAlert = defineResource({
  name: "WeatherAlert",
  table: "app.weather_alerts",
  description:
    "A weather alert raised by a reading at the highest level met, cleared when readings fall below every level.",
  serverSet: [
    "project_id",
    "hazard",
    "alert_level",
    "weather_reading_id",
    "issued_at",
    "cleared_at",
    ...AUDIT_SET,
  ],
  fields: {
    project_id: fields.ref("project"),
    hazard: label(["Wind", "Lightning", "Heat"], "Hazard."),
    alert_level: label(["Monitor", "Restrict", "Evacuate"], "Level met."),
    weather_reading_id: fields.ref("reading that raised it"),
    issued_at: fields.instant("When it was raised."),
    cleared_at: orNull(fields.instant("When it cleared.")),
    ...AUDIT,
  },
});

const GuestCheckIn = defineResource({
  name: "GuestCheckIn",
  table: "app.guest_check_ins",
  description:
    "A door check-in of an approved guest with plus-ones admitted and the credential scanned.",
  serverSet: ["credential_id", "checked_in_by_membership_id", ...AUDIT_SET],
  fields: {
    guest_list_entry_id: fields.ref("guest list entry"),
    plus_ones_admitted: fields.int("Plus-ones admitted.", 2),
    credential_id: orNull(fields.ref("credential scanned")),
    door: orNull(fields.text("Door or gate.", "Gate A", 80)),
    checked_in_by_membership_id: orNull(fields.ref("door staff member")),
    ...AUDIT,
  },
});

const DoorGuest = z
  .object({
    guest_list_entry_id: fields.uuid("Guest list entry."),
    guest_name: fields.text("Guest name.", "Jordan Ellis"),
    plus_ones: fields.int("Plus-ones on the list.", 2),
    entry_state: z
      .enum(["Approved", "Checked In"])
      .meta({ description: "Approved or Checked In.", example: "Approved" }),
    note: fields.text("Note for the door.", "Side stage.").nullable(),
    checked_in_at: fields.instant("When they were checked in.").nullable(),
    plus_ones_admitted: z
      .number()
      .int()
      .nullable()
      .meta({ description: "Plus-ones admitted.", example: 2 }),
    door: fields.text("Door.", "Gate A").nullable(),
  })
  .meta({ id: "DoorGuest", description: "A guest on the door list." });

const LostFoundItem = defineResource({
  name: "LostFoundItem",
  table: "app.lost_found_items",
  description: "An item in the lost and found log, with photos as attachments and its claim state.",
  immutable: ["project_id", "found_at", "found_location"],
  serverSet: ["item_number", "logged_by_membership_id", "item_state", ...AUDIT_SET],
  fields: {
    project_id: fields.ref("project"),
    item_number: fields.code("Display number.", "LF-0001"),
    category: label(
      ["Wallet", "Bag", "Clothing", "Electronics", "Jewelry", "Keys", "Documents", "Other"],
      "Category.",
    ),
    description: fields.text(
      "Description a claimant is checked against.",
      "Brown leather wallet.",
      1000,
    ),
    found_at: fields.instant("When it was found."),
    found_location: fields.text("Where it was found.", "Bar 2", 200),
    storage_location: orNull(fields.text("Where it is held.", "Security office locker 4", 200)),
    logged_by_membership_id: orNull(fields.ref("member who logged it")),
    item_state: label(["Logged", "Claimed", "Returned", "Disposed"], "Item state."),
    ...AUDIT,
  },
});

const LostFoundClaim = defineResource({
  name: "LostFoundClaim",
  table: "app.lost_found_claims",
  description:
    "A claim on a lost item: the claimant, their contact (Confidential), their proof and how it was settled.",
  serverSet: [
    "lost_found_item_id",
    "claimant_name",
    "claimant_contact",
    "proof_description",
    "recorded_by_membership_id",
    "decided_by_membership_id",
    "decided_at",
    "returned",
    "decision_note",
    ...AUDIT_SET,
  ],
  fields: {
    lost_found_item_id: fields.ref("item claimed"),
    claimant_name: fields.text("Claimant.", "Riley Park", 200),
    claimant_contact: fields.text("Claimant phone or email.", "+1 305 555 0142", 200),
    proof_description: fields.text("How they proved it.", "Named the card inside.", 1000),
    recorded_by_membership_id: orNull(fields.ref("member who took the claim")),
    decided_by_membership_id: orNull(fields.ref("member who settled it")),
    decided_at: orNull(fields.instant("When it was settled.")),
    returned: z
      .boolean()
      .nullable()
      .meta({ description: "True when returned, false when rejected.", example: true }),
    decision_note: orNull(fields.text("Why rejected, or a return note.", "ID matched.", 500)),
    ...AUDIT,
  },
});

// Additions ------------------------------------------------------------------------------------------------

const read = "inbox.notifications.read";

export const additions = defineAdditions("Workforce", {
  resources: [
    resource("Workforce", "/groups", Group, {
      op: "workforceGroups",
      verbs: ["list", "get", "create", "update"],
      actions: [
        itemAction("archive", {
          summary: "Archive a group",
          description:
            "Archives the group; it keeps its history and takes no new messages. Archiving is final.",
        }),
      ],
    }),
    resource("Workforce", "/group-members", GroupMember, {
      op: "workforceGroupMembers",
      verbs: ["list", "get", "create", "delete"],
    }),
    resource("Workforce", "/conversations", Conversation, {
      verbs: ["list", "get"],
      actions: [
        collectionAction("startDirect", {
          summary: "Start a direct conversation",
          description:
            "Opens, or returns, the one-to-one conversation with another active member of the org.",
          rpc: "app.start_direct_conversation",
          body: z
            .object({ other_membership_id: fields.uuid("The other member.") })
            .meta({ id: "DirectConversationRequest", description: "Whom to message." }),
        }),
        itemAction("markRead", {
          summary: "Mark a conversation read",
          description:
            "Marks the conversation read up to now for the caller and optionally mutes or unmutes it.",
          rpc: "app.mark_conversation_read",
          body: z
            .object({
              muted: z
                .boolean()
                .optional()
                .meta({ description: "Mute or unmute.", example: false }),
            })
            .meta({
              id: "MarkConversationReadRequest",
              description: "Read position and mute switch.",
            }),
        }),
        itemQuery("readReceipts", {
          summary: "Read receipts",
          description:
            "When the other members last read the conversation; empty while the org has read receipts off.",
          rpc: "app.conversation_read_receipts",
          paged: true,
          response: ReadReceipt,
        }),
      ],
    }),
    resource("Workforce", "/chat-messages", ChatMessage, {
      verbs: ["list", "get", "create", "update", "delete"],
    }),
    resource("Workforce", "/directory-entries", DirectoryEntry, {
      verbs: [],
      actions: [
        collectionQuery("search", {
          summary: "Search the directory",
          description:
            "The org directory, on-site members first, filtered by name or headline and optionally to those on site now.",
          rpc: "app.workforce_directory",
          paged: true,
          query: z.object({
            q: z
              .string()
              .max(200)
              .optional()
              .meta({ description: "Name or headline contains this.", example: "frank" }),
            on_site: z
              .enum(["true", "false"])
              .optional()
              .meta({ description: "Only members on site now.", example: "true" }),
          }),
        }),
      ],
    }),
    resource("Workforce", "/feed-posts", FeedPost, {
      verbs: ["list", "get", "create", "update"],
      order: { by: ["publish_at"], numeric: false, descending: true },
      actions: [
        collectionAction("createPoll", {
          summary: "Post a poll",
          description: "Posts a quick poll to the feed with 2 to 10 options.",
          rpc: "app.create_feed_post",
          status: 201,
          body: PollPostRequest,
        }),
        itemAction("pin", {
          summary: "Pin or unpin a post",
          description:
            "Pins the post to the top of the feed, or unpins it. Needs knowledge.sop.publish or org.communication.write.",
          rpc: "app.update_feed_post",
          body: z
            .object({ pinned: z.boolean().meta({ description: "Pinned.", example: true }) })
            .meta({ id: "PinFeedPostRequest", description: "Pin switch." }),
        }),
        itemAction("hide", {
          summary: "Hide a post",
          description: "Hides the post with a reason; it leaves everyone else's feed.",
          rpc: "app.hide_feed_post",
          body: reasonBody("HideFeedPostRequest", "Why the post is hidden."),
        }),
        itemAction("acknowledge", {
          summary: "Acknowledge a post",
          description: "Records that the caller acknowledged a post that requires it.",
          rpc: "app.acknowledge_feed_post",
        }),
        itemAction("react", {
          summary: "React to a post",
          description: "Adds or removes the caller's reaction from the curated set.",
          rpc: "app.react_to_feed_post",
          body: z
            .object({
              reaction_code: z
                .enum(["thumbs_up", "heart", "check", "eyes", "laugh", "celebrate"])
                .meta({ description: "Reaction.", example: "heart" }),
              on: z
                .boolean()
                .optional()
                .meta({ description: "Add (default) or remove.", example: true }),
            })
            .meta({ id: "FeedReactionRequest", description: "A reaction." }),
        }),
        itemQuery("acknowledgments", {
          summary: "Acknowledgment status",
          description:
            "Each member of the audience and when they acknowledged the post, outstanding first.",
          rpc: "app.feed_acknowledgment_status",
          paged: true,
          response: AcknowledgmentStatus,
        }),
      ],
    }),
    resource("Workforce", "/polls", Poll, {
      verbs: ["list", "get"],
      actions: [
        itemAction("vote", {
          summary: "Vote in a poll",
          description: "Votes once: one option, or several when the poll allows it.",
          rpc: "app.vote_in_poll",
          body: z
            .object({
              option_ids: z
                .array(z.uuid())
                .min(1)
                .meta({
                  description: "Options chosen.",
                  example: ["0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f"],
                }),
            })
            .meta({ id: "PollVoteRequest", description: "Options chosen." }),
        }),
        itemQuery("results", {
          summary: "Poll results",
          description: "Votes per option.",
          rpc: "app.poll_results",
          paged: true,
          response: PollResult,
        }),
      ],
    }),
    resource("Workforce", "/surveys", Survey, {
      verbs: ["list", "get"],
      actions: [
        collectionAction("draft", {
          summary: "Draft a survey",
          description: "Drafts a pulse survey with its questions.",
          rpc: "app.create_survey",
          status: 201,
          body: SurveyDraftRequest,
        }),
        itemAction("transition", {
          summary: "Open or close a survey",
          description: "Opens a draft survey (notifying its audience) or closes an open one.",
          rpc: "app.transition_survey",
          body: transition(
            "SurveyTransitionRequest",
            ["Draft", "Open", "Closed"],
            ["Draft", "Open"],
          ),
          response: Ledger,
        }),
        itemAction("respond", {
          summary: "Respond to a survey",
          description:
            "Responds once with answers keyed by question id. Anonymous answers carry no respondent.",
          rpc: "app.respond_to_survey",
          body: z
            .object({
              answers: z
                .record(z.string(), z.union([z.string(), z.number()]))
                .meta({
                  description: "Answers keyed by question id.",
                  example: { "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f": 4 },
                }),
            })
            .meta({ id: "SurveyResponseRequest", description: "Survey answers." }),
          response: z
            .object({
              response_id: fields.uuid("The response, or null for an anonymous survey.").nullable(),
            })
            .meta({ id: "SurveyResponseResult", description: "The response written." }),
        }),
        itemQuery("results", {
          summary: "Survey results",
          description: "Results, shown only once the minimum number of responses is met.",
          rpc: "app.survey_results",
          response: SurveyResults,
        }),
      ],
    }),
    resource("Workforce", "/survey-questions", SurveyQuestion, { verbs: ["list", "get"] }),
    resource("Workforce", "/recognitions", Recognition, { verbs: ["list", "get", "create"] }),
    resource("Workforce", "/workforce-events", WorkforceEvent, {
      verbs: ["list", "get", "create", "update"],
      actions: [
        itemAction("cancel", {
          summary: "Cancel an event",
          description: "Cancels the event with a reason; cancellation is final.",
          body: reasonBody("CancelWorkforceEventRequest", "Why it is canceled."),
        }),
        itemAction("rsvp", {
          summary: "RSVP to an event",
          description: "Records or changes the caller's RSVP.",
          rpc: "app.rsvp_to_event",
          body: z
            .object({
              response: z
                .enum(["Going", "Maybe", "Declined"])
                .meta({ description: "Answer.", example: "Going" }),
            })
            .meta({ id: "RsvpRequest", description: "An RSVP." }),
          response: EventRsvp.read,
        }),
        itemAction("checkIn", {
          summary: "Check in to an event",
          description:
            "Checks the caller in, or another invitee when the caller organizes the event, from an hour before the start to the end.",
          rpc: "app.check_in_to_event",
          body: z
            .object({
              membership_id: fields.uuid("Invitee to check in; the caller by default.").optional(),
              method: z
                .enum(["Self", "Organizer", "Scan"])
                .optional()
                .meta({ description: "How.", example: "Self" }),
            })
            .meta({ id: "EventCheckInRequest", description: "A check-in." }),
          response: EventCheckIn.read,
        }),
      ],
    }),
    resource("Workforce", "/event-rsvps", EventRsvp, { verbs: ["list", "get"] }),
    resource("Workforce", "/event-check-ins", EventCheckIn, { verbs: ["list", "get"] }),
    resource("Workforce", "/form-templates", FormTemplate, {
      verbs: ["list", "get", "create", "update"],
      order: { by: ["name"], numeric: false },
      actions: [
        itemAction("publish", {
          summary: "Publish a form",
          description: "Publishes a draft form as its next version.",
          rpc: "app.publish_form_template",
        }),
        itemAction("retire", {
          summary: "Retire a form",
          description: "Retires a published form; it keeps its submissions.",
          rpc: "app.retire_form_template",
          body: reasonBody("RetireFormRequest", "Why it is retired."),
        }),
      ],
    }),
    resource("Workforce", "/form-submissions", FormSubmission, {
      verbs: ["list", "get", "create"],
      actions: [
        itemAction("decide", {
          summary: "Approve or reject a submission",
          description:
            "A holder of the form's approver role decides a submitted form; never the submitter. A rejection needs a note.",
          rpc: "app.decide_form_submission",
          body: z
            .object({
              approve: z.boolean().meta({ description: "Approve or reject.", example: true }),
              note: z
                .string()
                .min(1)
                .max(1000)
                .optional()
                .meta({ description: "Note; required to reject.", example: "Good to lift." }),
            })
            .meta({ id: "FormDecisionRequest", description: "A decision." }),
        }),
      ],
    }),
    resource("Workforce", "/training-courses", TrainingCourse, {
      verbs: ["list", "get", "create", "update"],
      order: { by: ["title"], numeric: false },
      actions: [
        itemAction("publish", {
          summary: "Publish a course",
          description: "Publishes a draft course with at least one lesson and every quiz keyed.",
          rpc: "app.publish_training_course",
        }),
        itemAction("retire", {
          summary: "Retire a course",
          description: "Retires a published course.",
          rpc: "app.retire_training_course",
          body: reasonBody("RetireCourseRequest", "Why it is retired."),
        }),
        itemAction("assign", {
          summary: "Assign a course",
          description: "Assigns a published course to active members with an optional due date.",
          rpc: "app.assign_training",
          body: z
            .object({
              membership_ids: z
                .array(z.uuid())
                .min(1)
                .meta({
                  description: "Learners.",
                  example: ["0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f"],
                }),
              due_on: z.iso
                .date()
                .optional()
                .meta({ description: "Due date.", example: "2026-10-20" }),
              reason: z
                .string()
                .max(300)
                .optional()
                .meta({ description: "Why.", example: "New riggers" }),
            })
            .meta({ id: "AssignTrainingRequest", description: "Learners to assign." }),
          response: z
            .object({ assigned: fields.int("Newly assigned learners.", 2) })
            .meta({ id: "AssignTrainingResult", description: "How many were assigned." }),
        }),
        itemAction("complete", {
          summary: "Complete a course",
          description:
            "Grades the caller's quiz answers once every reading and video lesson is finished.",
          rpc: "app.complete_training",
          body: z
            .object({
              answers: z
                .record(z.string(), z.number().int().min(1).max(6))
                .meta({
                  description: "Option numbers keyed by question id.",
                  example: { "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f": 1 },
                }),
            })
            .meta({ id: "CompleteTrainingRequest", description: "Quiz answers." }),
          response: TrainingCompletion.read,
        }),
      ],
    }),
    resource("Workforce", "/training-lessons", TrainingLesson, {
      verbs: ["list", "get", "create", "update", "delete"],
      actions: [
        itemAction("complete", {
          summary: "Finish a lesson",
          description: "Marks a reading or video lesson finished for the caller.",
          rpc: "app.complete_training_lesson",
        }),
      ],
    }),
    resource("Workforce", "/training-quiz-questions", TrainingQuizQuestion, {
      verbs: ["list", "get", "create", "update"],
    }),
    resource("Workforce", "/training-quiz-keys", TrainingQuizKey, {
      verbs: ["list", "get", "create", "update"],
    }),
    resource("Workforce", "/training-assignments", TrainingAssignment, {
      verbs: ["list", "get", "delete"],
    }),
    resource("Workforce", "/training-completions", TrainingCompletion, {
      verbs: ["list", "get"],
      actions: [
        itemAction("issueCertification", {
          summary: "Issue the certification",
          description:
            "A verifier issues the certification a passed course grants, never the learner.",
          rpc: "app.issue_training_certification",
        }),
      ],
    }),
    resource("Workforce", "/handbook-sections", HandbookSection, {
      verbs: ["list", "get", "create", "update"],
      order: { by: ["position"], numeric: false },
    }),
    resource("Workforce", "/handbook-articles", HandbookArticle, {
      verbs: ["list", "get", "create", "update"],
      order: { by: ["title"], numeric: false },
      actions: [
        itemAction("publish", {
          summary: "Publish an article",
          description:
            "Publishes the working text as the next version; a mandatory article then asks everyone to acknowledge it.",
          rpc: "app.publish_handbook_article",
          body: z
            .object({
              change_summary: z
                .string()
                .max(500)
                .optional()
                .meta({ description: "What changed.", example: "Added the distance." }),
            })
            .meta({ id: "PublishArticleRequest", description: "What changed." }),
        }),
        itemAction("acknowledge", {
          summary: "Acknowledge an article",
          description: "Records that the caller read the current version.",
          rpc: "app.acknowledge_handbook_article",
        }),
        itemAction("archive", {
          summary: "Archive an article",
          description: "Withdraws a published article.",
        }),
      ],
    }),
    resource("Workforce", "/knowledge-sources", KnowledgeSource, {
      verbs: [],
      actions: [
        collectionQuery("search", {
          summary: "Search knowledge sources",
          description:
            "The Assistant's sources: published handbook articles, SOPs and training lessons the caller can read that match the question, ranked, with routes to cite.",
          rpc: "app.assistant_knowledge_sources",
          paged: true,
          query: z.object({
            q: z
              .string()
              .min(1)
              .max(500)
              .meta({ description: "The question.", example: "hearing protection" }),
            limit: z.coerce
              .number()
              .int()
              .min(1)
              .max(25)
              .optional()
              .meta({ description: "At most this many.", example: 8 }),
          }),
        }),
      ],
    }),
    resource("Workforce", "/help-desk-teams", HelpDeskTeam, {
      verbs: ["list", "get", "create", "update"],
      order: { by: ["name"], numeric: false },
      actions: [
        itemAction("archive", {
          summary: "Archive a team",
          description: "The team stops taking requests.",
        }),
      ],
    }),
    resource("Workforce", "/help-desk-team-members", HelpDeskTeamMember, {
      verbs: ["list", "get", "create", "delete"],
    }),
    resource("Workforce", "/help-desk-requests", HelpDeskRequest, {
      verbs: ["list", "get", "create"],
      actions: [
        itemAction("assign", {
          summary: "Assign a request",
          description:
            "Assigns the request to a member of its team, optionally moving it to another team.",
          rpc: "app.assign_help_desk_request",
          body: z
            .object({
              assignee_membership_id: fields.uuid("Team member; null unassigns.").nullable(),
              help_desk_team_id: fields.uuid("Team to move the request to.").optional(),
            })
            .meta({ id: "AssignHelpDeskRequest", description: "Assignment." }),
        }),
        itemAction("answer", {
          summary: "Answer a request",
          description: "A team member answers; the first answer records the response time.",
          rpc: "app.answer_help_desk_request",
          status: 201,
          body: z
            .object({
              body: z
                .string()
                .min(1)
                .max(10000)
                .meta({ description: "Answer.", example: "Restarting the profile now." }),
            })
            .meta({ id: "AnswerHelpDeskRequest", description: "An answer." }),
          response: HelpDeskMessage,
        }),
        itemAction("transition", {
          summary: "Move a request",
          description:
            "A team member moves the request through Open, Waiting, Resolved and Closed with a reason.",
          rpc: "app.transition_help_desk_request",
          body: transition(
            "HelpDeskTransitionRequest",
            ["Open", "Waiting", "Resolved", "Closed"],
            ["Open", "Resolved"],
          ),
          response: Ledger,
        }),
      ],
    }),
    resource("Workforce", "/occupancy-counters", OccupancyCounter, {
      verbs: ["list", "get"],
      order: { by: ["name"], numeric: false },
      actions: [
        collectionAction("setUp", {
          summary: "Set up a counter",
          description:
            "Sets up a counter sized by a permit load, a Bible occupant load factor or the space capacity.",
          rpc: "app.create_occupancy_counter",
          status: 201,
          body: CounterCreateRequest,
        }),
        itemAction("count", {
          summary: "Count people in or out",
          description:
            "Counts people in (positive) or out (negative) at a door. Crossing 80, 90 or 100 percent alerts the dispatchers.",
          rpc: "app.record_occupancy_count",
          body: z
            .object({
              delta: z
                .number()
                .int()
                .min(-500)
                .max(500)
                .meta({ description: "People in or out.", example: 1 }),
              door: z.string().max(80).optional().meta({ description: "Door.", example: "Gate A" }),
            })
            .meta({ id: "OccupancyCountRequest", description: "A door count." }),
        }),
        itemAction("close", {
          summary: "Close a counter",
          description: "Stops counting.",
          rpc: "app.close_occupancy_counter",
        }),
      ],
    }),
    resource("Workforce", "/weather-thresholds", WeatherThreshold, {
      verbs: ["list", "get", "create", "update"],
    }),
    resource("Workforce", "/weather-alert-roles", WeatherAlertRole, {
      verbs: ["list", "get", "create", "delete"],
    }),
    resource("Workforce", "/weather-readings", WeatherReading, {
      verbs: ["list", "get", "create"],
      order: { by: ["observed_at"], numeric: false, descending: true },
    }),
    resource("Workforce", "/weather-alerts", WeatherAlert, {
      verbs: ["list", "get"],
      order: { by: ["issued_at"], numeric: false, descending: true },
    }),
    resource("Workforce", "/guest-check-ins", GuestCheckIn, {
      verbs: ["list", "get", "create"],
      actions: [
        collectionQuery("doorList", {
          summary: "Door list",
          description:
            "Approved and checked-in guests of a project for door staff, filtered by name.",
          rpc: "app.door_guest_list",
          paged: true,
          response: DoorGuest,
          query: z.object({
            project_id: fields.uuid("Project."),
            q: z
              .string()
              .max(200)
              .optional()
              .meta({ description: "Name contains this.", example: "jordan" }),
          }),
        }),
      ],
    }),
    resource("Workforce", "/lost-found-items", LostFoundItem, {
      verbs: ["list", "get", "create", "update"],
      order: { by: ["found_at"], numeric: false, descending: true },
      actions: [
        itemAction("claim", {
          summary: "Record a claim",
          description:
            "Records a claim on a held item with the claimant's name, contact and proof.",
          rpc: "app.claim_lost_item",
          status: 201,
          body: z
            .object({
              claimant_name: z
                .string()
                .min(1)
                .max(200)
                .meta({ description: "Claimant.", example: "Riley Park" }),
              claimant_contact: z
                .string()
                .min(3)
                .max(200)
                .meta({ description: "Phone or email.", example: "+1 305 555 0142" }),
              proof_description: z
                .string()
                .min(1)
                .max(1000)
                .meta({ description: "Proof.", example: "Named the card inside." }),
            })
            .meta({ id: "LostItemClaimRequest", description: "A claim." }),
          response: LostFoundClaim.read,
        }),
        itemAction("dispose", {
          summary: "Dispose of an item",
          description: "Disposes of an unclaimed held item with a reason.",
          rpc: "app.dispose_lost_item",
          body: reasonBody("DisposeLostItemRequest", "Why it is disposed of."),
        }),
      ],
    }),
    resource("Workforce", "/lost-found-claims", LostFoundClaim, {
      verbs: ["list", "get"],
      actions: [
        itemAction("settle", {
          summary: "Settle a claim",
          description:
            "Returns the item to the verified claimant, or rejects the claim with a reason.",
          rpc: "app.settle_lost_item_claim",
          body: z
            .object({
              returned: z
                .boolean()
                .meta({ description: "Returned (true) or rejected (false).", example: true }),
              note: z
                .string()
                .min(1)
                .max(500)
                .optional()
                .meta({ description: "Note; required to reject.", example: "ID matched." }),
            })
            .meta({ id: "SettleClaimRequest", description: "Settlement." }),
        }),
      ],
    }),
  ],
  capabilities: {
    workforceGroups: { read, write: "org.communication.write" },
    workforceGroupMembers: { read, write: "org.communication.write" },
    conversations: { read, write: "inbox.notifications.write" },
    chatMessages: { read, write: "inbox.notifications.write" },
    directoryEntries: { read: "inbox.notifications.read" },
    feedPosts: {
      read: "knowledge.sop.read",
      write: "knowledge.document.write",
      actions: {
        pin: "knowledge.sop.publish",
        hide: "knowledge.document.write",
        acknowledge: "knowledge.sop.acknowledge",
        react: "knowledge.sop.acknowledge",
      },
    },
    polls: { read: "knowledge.sop.read", actions: { vote: "knowledge.sop.acknowledge" } },
    surveys: {
      read: "knowledge.sop.read",
      write: "knowledge.sop.publish",
      actions: { respond: "knowledge.sop.acknowledge", results: "knowledge.sop.publish" },
    },
    surveyQuestions: { read: "knowledge.sop.read" },
    recognitions: { read: "knowledge.sop.read", write: "knowledge.sop.acknowledge" },
    workforceEvents: {
      read: "schedule.timeline.read",
      write: "schedule.timeline.write",
      actions: { rsvp: "schedule.timeline.read", checkIn: "schedule.timeline.read" },
    },
    eventRsvps: { read: "schedule.timeline.read" },
    eventCheckIns: { read: "schedule.timeline.read" },
    formTemplates: {
      read: "knowledge.sop.read",
      write: "knowledge.sop.write",
      actions: { publish: "knowledge.sop.publish", retire: "knowledge.sop.publish" },
    },
    formSubmissions: {
      read: "knowledge.sop.read",
      write: "knowledge.sop.acknowledge",
      actions: { decide: "knowledge.sop.read" },
    },
    trainingCourses: {
      read: "knowledge.sop.read",
      write: "knowledge.sop.publish",
      actions: { complete: "knowledge.sop.acknowledge" },
    },
    trainingLessons: {
      read: "knowledge.sop.read",
      write: "knowledge.sop.publish",
      actions: { complete: "knowledge.sop.acknowledge" },
    },
    trainingQuizQuestions: { read: "knowledge.sop.read", write: "knowledge.sop.publish" },
    trainingQuizKeys: { read: "knowledge.sop.publish", write: "knowledge.sop.publish" },
    trainingAssignments: { read: "knowledge.sop.read", write: "knowledge.sop.publish" },
    trainingCompletions: {
      read: "knowledge.sop.read",
      actions: { issueCertification: "people.certification.verify" },
    },
    handbookSections: { read: "knowledge.sop.read", write: "knowledge.sop.write" },
    handbookArticles: {
      read: "knowledge.sop.read",
      write: "knowledge.sop.write",
      actions: {
        publish: "knowledge.sop.publish",
        acknowledge: "knowledge.sop.acknowledge",
        archive: "knowledge.sop.publish",
      },
    },
    knowledgeSources: { read: "knowledge.sop.read" },
    helpDeskTeams: { read, write: "org.help.write" },
    helpDeskTeamMembers: { read, write: "org.help.write" },
    helpDeskRequests: { read, write: "inbox.notifications.write" },
    occupancyCounters: {
      read: "safety.incident.read",
      write: "safety.emergency_code.write",
      actions: { count: "safety.incident.write" },
    },
    weatherThresholds: { read: "safety.incident.read", write: "safety.emergency_code.write" },
    weatherAlertRoles: { read: "safety.incident.read", write: "safety.emergency_code.write" },
    weatherReadings: { read: "safety.incident.read", write: "safety.incident.write" },
    weatherAlerts: { read: "safety.incident.read" },
    guestCheckIns: { read: "credentials.scan.write", write: "credentials.scan.write" },
    lostFoundItems: {
      read: "safety.incident.read",
      write: "safety.incident.write",
      actions: { dispose: "safety.incident.close" },
    },
    lostFoundClaims: { read: "safety.incident.read", actions: { settle: "safety.incident.close" } },
  },
});
