/**
 * Contract tests for A29's Workforce handlers (Section 18, gate 5). Requests run through
 * `contractApp` against the in-memory client and every response is checked against openapi/v1.json
 * with `expectContract`. The RPCs are stand-ins that write or return the rows the database would, and
 * refuse the way it does (XR001 with the rule), so refusals (422) and hidden rows (404) are covered.
 */
import { describe, expect, it } from "vitest";
import { handlers as workforce } from "../src/handlers/workforce.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { MemoryDb, Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const ME = testContext().personId as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;

const MEMBER = id(1);
const OTHER = id(2);
const PROJECT = id(3);
const GROUP = id(10);
const GROUP_MEMBER = id(11);
const CONVERSATION = id(12);
const MESSAGE = id(13);
const POST = id(20);
const POLL = id(21);
const OPTION = id(22);
const SURVEY = id(23);
const QUESTION = id(24);
const RECOGNITION = id(25);
const EVENT = id(30);
const RSVP = id(31);
const CHECK_IN = id(32);
const TEMPLATE = id(40);
const VERSION = id(41);
const SUBMISSION = id(42);
const COURSE = id(50);
const LESSON = id(51);
const QUIZ_QUESTION = id(52);
const QUIZ_KEY = id(53);
const ASSIGNMENT = id(54);
const COMPLETION = id(55);
const SECTION = id(56);
const ARTICLE = id(57);
const TEAM = id(60);
const TEAM_MEMBER = id(61);
const TICKET = id(62);
const COUNTER = id(70);
const THRESHOLD = id(71);
const ALERT_ROLE = id(72);
const READING = id(73);
const ALERT = id(74);
const ENTRY = id(75);
const GUEST_CHECK_IN = id(76);
const ITEM = id(77);
const CLAIM = id(78);
const MISSING = id(9999);
const T = "2026-10-01T12:00:00.000Z";

const audience = {
  audience_kind: "Organization",
  project_id: null,
  team_id: null,
  role_id: null,
  group_id: null,
};

function push(db: MemoryDb, table: string, row: Row) {
  db.tables[table]?.push(row);
  return row["id"];
}

function world() {
  const db = memoryDb(
    {
      memberships: [
        tenantRow(MEMBER, ORG, { person_id: ME }),
        tenantRow(OTHER, ORG, { person_id: id(900) }),
      ],
      groups: [
        tenantRow(GROUP, ORG, {
          name: "Rigging Crew",
          group_kind: "Crew",
          project_id: null,
          description: null,
          archived_at: null,
        }),
      ],
      group_members: [
        tenantRow(GROUP_MEMBER, ORG, {
          group_id: GROUP,
          membership_id: MEMBER,
          group_role: "Owner",
        }),
      ],
      conversations: [
        tenantRow(CONVERSATION, ORG, {
          conversation_kind: "Group",
          group_id: GROUP,
          direct_key: null,
          last_message_at: T,
        }),
      ],
      chat_messages: [
        tenantRow(MESSAGE, ORG, {
          conversation_id: CONVERSATION,
          author_membership_id: MEMBER,
          message_kind: "Text",
          body: "Points are up.",
          language: "en",
          edited_at: null,
        }),
      ],
      feed_posts: [
        tenantRow(POST, ORG, {
          post_kind: "Announcement",
          title: "Wristbands",
          body: "Colors change Friday.",
          ...audience,
          author_membership_id: MEMBER,
          pinned_at: null,
          requires_acknowledgment: true,
          reactions_enabled: true,
          comments_enabled: true,
          publish_at: T,
          notified_at: T,
          hidden_at: null,
          hidden_reason: null,
        }),
      ],
      polls: [
        tenantRow(POLL, ORG, {
          feed_post_id: POST,
          question: "Meal?",
          allows_multiple: false,
          closes_at: null,
        }),
      ],
      surveys: [
        tenantRow(SURVEY, ORG, {
          title: "Pulse",
          description: null,
          ...audience,
          author_membership_id: MEMBER,
          is_anonymous: true,
          min_responses: 3,
          survey_state: "Draft",
          closes_at: null,
        }),
      ],
      survey_questions: [
        tenantRow(QUESTION, ORG, {
          survey_id: SURVEY,
          position: 1,
          prompt: "Safe?",
          question_kind: "Scale",
          choices: null,
          scale_max: 5,
          is_required: true,
        }),
      ],
      recognitions: [
        tenantRow(RECOGNITION, ORG, {
          from_membership_id: MEMBER,
          to_membership_id: OTHER,
          project_id: null,
          shift_id: null,
          message: "Great work.",
          feed_post_id: POST,
        }),
      ],
      workforce_events: [
        tenantRow(EVENT, ORG, {
          event_kind: "Briefing",
          title: "Safety brief",
          agenda: null,
          location: "Dock 3",
          venue_id: null,
          space_id: null,
          ...audience,
          organizer_membership_id: MEMBER,
          starts_at: T,
          ends_at: "2026-10-01T13:00:00.000Z",
          rsvp_required: true,
          canceled_at: null,
          cancel_reason: null,
        }),
      ],
      event_rsvps: [
        tenantRow(RSVP, ORG, {
          workforce_event_id: EVENT,
          membership_id: MEMBER,
          response: "Going",
          responded_at: T,
        }),
      ],
      event_check_ins: [
        tenantRow(CHECK_IN, ORG, {
          workforce_event_id: EVENT,
          membership_id: MEMBER,
          check_in_method: "Self",
          checked_in_at: T,
        }),
      ],
      form_templates: [
        tenantRow(TEMPLATE, ORG, {
          name: "Pre-use check",
          description: null,
          record_kind: "Inspection",
          record_subtype: "Safety",
          fields: [{ key: "ok", label: "OK", kind: "yes_no", required: true }],
          requires_signature: false,
          requires_location: false,
          pass_score: null,
          approver_role_id: null,
          template_state: "Draft",
          current_version: 0,
        }),
      ],
      form_submissions: [
        tenantRow(SUBMISSION, ORG, {
          form_template_id: TEMPLATE,
          form_template_version_id: VERSION,
          project_id: null,
          record_id: null,
          submitted_by_membership_id: MEMBER,
          answers: { ok: true },
          score: null,
          max_score: null,
          passed: null,
          latitude: null,
          longitude: null,
          accuracy_m: null,
          signer_name: null,
          signature_path: null,
          signed_at: null,
          submission_state: "Submitted",
          decided_by_membership_id: null,
          decision_note: null,
        }),
      ],
      training_courses: [
        tenantRow(COURSE, ORG, {
          title: "Rigging basics",
          summary: null,
          role_code: null,
          certification_id: null,
          gate_criterion_id: null,
          validity_days: 365,
          pass_percent: 80,
          estimated_minutes: 20,
          course_state: "Draft",
        }),
      ],
      training_lessons: [
        tenantRow(LESSON, ORG, {
          training_course_id: COURSE,
          position: 1,
          title: "Slings",
          lesson_kind: "Reading",
          body: "Inspect.",
          video_url: null,
        }),
      ],
      training_quiz_questions: [
        tenantRow(QUIZ_QUESTION, ORG, {
          training_lesson_id: LESSON,
          position: 1,
          prompt: "Inspect?",
          options: ["Yes", "No"],
        }),
      ],
      training_quiz_keys: [
        tenantRow(QUIZ_KEY, ORG, { training_quiz_question_id: QUIZ_QUESTION, correct_option: 1 }),
      ],
      training_assignments: [
        tenantRow(ASSIGNMENT, ORG, {
          training_course_id: COURSE,
          membership_id: OTHER,
          assigned_by_membership_id: MEMBER,
          due_on: "2026-10-20",
          reason: null,
        }),
      ],
      training_completions: [
        tenantRow(COMPLETION, ORG, {
          training_course_id: COURSE,
          membership_id: OTHER,
          score_percent: 100,
          passed: true,
          completed_at: T,
          expires_at: "2027-10-01T12:00:00.000Z",
          certificate_number: "TRN-0001",
          certification_holder_id: null,
        }),
      ],
      handbook_sections: [tenantRow(SECTION, ORG, { name: "Site rules", position: 1 })],
      handbook_articles: [
        tenantRow(ARTICLE, ORG, {
          handbook_section_id: SECTION,
          title: "Hearing",
          body: "Wear protection.",
          is_mandatory: true,
          article_state: "Draft",
          published_version: 0,
          published_at: null,
        }),
      ],
      help_desk_teams: [
        tenantRow(TEAM, ORG, {
          name: "IT Desk",
          team_kind: "IT",
          description: null,
          first_response_hours: 4,
          archived_at: null,
        }),
      ],
      help_desk_team_members: [
        tenantRow(TEAM_MEMBER, ORG, { help_desk_team_id: TEAM, membership_id: MEMBER }),
      ],
      support_tickets: [
        tenantRow(TICKET, ORG, {
          queue: "Organization",
          ticket_number: "SUP-0001",
          help_desk_team_id: TEAM,
          category: "Access",
          severity: "Severity 3",
          subject: "Tablet",
          body: "Blank screen.",
          ticket_state: "Open",
          membership_id: OTHER,
          assignee_membership_id: null,
          help_desk_response_due_at: T,
          first_responded_at: null,
        }),
      ],
      occupancy_counters: [
        tenantRow(COUNTER, ORG, {
          project_id: PROJECT,
          space_id: null,
          name: "Main Floor",
          load_basis: "Permit",
          metric_domain: null,
          metric_item: null,
          permitted_load: 100,
          current_count: 10,
          alert_level_percent: 0,
          closed_at: null,
        }),
      ],
      weather_thresholds: [
        tenantRow(THRESHOLD, ORG, {
          project_id: PROJECT,
          hazard: "Wind",
          alert_level: "Restrict",
          threshold_value: 30,
          unit: "mph",
          comparison: "At or Above",
          source_note: "Plan 4.2",
        }),
      ],
      weather_alert_roles: [
        tenantRow(ALERT_ROLE, ORG, {
          project_id: PROJECT,
          alert_level: "Evacuate",
          role_code: "5000.01.01",
        }),
      ],
      weather_readings: [
        tenantRow(READING, ORG, {
          project_id: PROJECT,
          hazard: "Wind",
          reading_value: 33,
          observed_at: T,
          recorded_by_membership_id: MEMBER,
        }),
      ],
      weather_alerts: [
        tenantRow(ALERT, ORG, {
          project_id: PROJECT,
          hazard: "Wind",
          alert_level: "Restrict",
          weather_reading_id: READING,
          issued_at: T,
          cleared_at: null,
        }),
      ],
      guest_check_ins: [
        tenantRow(GUEST_CHECK_IN, ORG, {
          guest_list_entry_id: ENTRY,
          plus_ones_admitted: 1,
          credential_id: null,
          door: "Gate A",
          checked_in_by_membership_id: MEMBER,
        }),
      ],
      lost_found_items: [
        tenantRow(ITEM, ORG, {
          project_id: PROJECT,
          item_number: "LF-0001",
          category: "Wallet",
          description: "Brown wallet.",
          found_at: T,
          found_location: "Bar 2",
          storage_location: null,
          logged_by_membership_id: MEMBER,
          item_state: "Logged",
        }),
      ],
      lost_found_claims: [
        tenantRow(CLAIM, ORG, {
          lost_found_item_id: ITEM,
          claimant_name: "Riley Park",
          claimant_contact: "+1 305 555 0142",
          proof_description: "Card inside.",
          recorded_by_membership_id: MEMBER,
          decided_by_membership_id: null,
          decided_at: null,
          returned: null,
          decision_note: null,
        }),
      ],
    },
    {
      start_direct_conversation: () => CONVERSATION,
      mark_conversation_read: () => T,
      conversation_read_receipts: () => [
        { membership_id: OTHER, full_name: "Carol Nguyen", last_read_at: T },
      ],
      send_chat_message: (args, self) => {
        if (args["p_body"] === "refuse") throw refusal("group_archived");
        return push(
          self,
          "chat_messages",
          tenantRow(id(100), ORG, {
            conversation_id: args["p_conversation_id"],
            author_membership_id: MEMBER,
            message_kind: args["p_message_kind"] ?? "Text",
            body: args["p_body"],
            language: null,
            edited_at: null,
          }),
        );
      },
      edit_chat_message: (args, self) => {
        const row = self.tables["chat_messages"]?.find(
          (r) => r["id"] === args["p_message_id"],
        ) as Row;
        row["body"] = args["p_body"];
        row["edited_at"] = T;
        return args["p_message_id"];
      },
      delete_chat_message: (args, self) => {
        const row = self.tables["chat_messages"]?.find(
          (r) => r["id"] === args["p_message_id"],
        ) as Row;
        row["deleted_at"] = T;
        return args["p_message_id"];
      },
      workforce_directory: () => [
        {
          membership_id: MEMBER,
          person_id: ME,
          full_name: "Frank Adeyemi",
          preferred_name: null,
          headline: null,
          photo_path: null,
          role_names: ["Field"],
          on_site_now: true,
          on_site_project_id: PROJECT,
          on_site_since: T,
          work_phone: null,
          recognition_count: null,
        },
      ],
      create_feed_post: (args) => {
        // A Department audience (1365) passes its canon department code through.
        if (args["p_audience_kind"] === "Department" && args["p_department_code"] !== "5000")
          throw refusal("audience_target");
        return POST;
      },
      update_feed_post: () => POST,
      hide_feed_post: () => POST,
      acknowledge_feed_post: () => id(101),
      react_to_feed_post: (args) => {
        if (args["p_reaction_code"] === "eyes") throw refusal("feed_post_reactions_off");
        return true;
      },
      feed_acknowledgment_status: () => [
        { membership_id: OTHER, person_id: id(900), full_name: "Carol", acknowledged_at: null },
      ],
      vote_in_poll: () => 1,
      poll_results: () => [
        { poll_option_id: OPTION, option_position: 1, label: "Tacos", votes: 2, voters: 3 },
      ],
      create_survey: () => SURVEY,
      transition_survey: () => id(102),
      respond_to_survey: () => null,
      survey_results: () => ({
        survey_id: SURVEY,
        responses: 1,
        min_responses: 3,
        threshold_met: false,
        audience: 8,
        questions: [],
      }),
      recognize: () => RECOGNITION,
      rsvp_to_event: () => RSVP,
      check_in_to_event: () => CHECK_IN,
      publish_form_template: () => 1,
      retire_form_template: () => id(103),
      submit_form: () => SUBMISSION,
      decide_form_submission: () => id(104),
      publish_training_course: () => id(105),
      retire_training_course: () => id(106),
      assign_training: () => 2,
      complete_training: () => COMPLETION,
      complete_training_lesson: () => id(107),
      issue_training_certification: () => id(108),
      publish_handbook_article: () => 1,
      acknowledge_handbook_article: () => id(109),
      assistant_knowledge_sources: () => [
        {
          source_kind: "Handbook",
          source_id: ARTICLE,
          title: "Hearing",
          version: 1,
          excerpt: "Wear protection.",
          route: "/northwind-live/knowledge/handbook?peek=x",
          rank: 0.4,
        },
      ],
      open_help_desk_request: () => TICKET,
      assign_help_desk_request: () => TICKET,
      answer_help_desk_request: () => id(110),
      transition_help_desk_request: () => id(111),
      create_occupancy_counter: () => COUNTER,
      record_occupancy_count: () => 11,
      close_occupancy_counter: () => COUNTER,
      record_weather_reading: () => READING,
      check_in_guest: () => GUEST_CHECK_IN,
      door_guest_list: () => [
        {
          guest_list_entry_id: ENTRY,
          guest_name: "Jordan Ellis",
          plus_ones: 2,
          entry_state: "Approved",
          note: null,
          checked_in_at: null,
          plus_ones_admitted: null,
          door: null,
        },
      ],
      log_lost_item: () => ITEM,
      claim_lost_item: () => CLAIM,
      dispose_lost_item: () => id(112),
      settle_lost_item_claim: () => CLAIM,
    },
    {
      groups: { archived_at: null, description: null, project_id: null },
      group_members: { group_role: "Member" },
      workforce_events: {
        canceled_at: null,
        cancel_reason: null,
        agenda: null,
        venue_id: null,
        space_id: null,
      },
      form_templates: {
        template_state: "Draft",
        current_version: 0,
        description: null,
        record_subtype: null,
      },
      training_courses: {
        course_state: "Draft",
        summary: null,
        role_code: null,
        certification_id: null,
        gate_criterion_id: null,
      },
      training_lessons: { body: null, video_url: null },
      handbook_sections: {},
      handbook_articles: {
        article_state: "Draft",
        published_version: 0,
        published_at: null,
        handbook_section_id: null,
      },
      help_desk_teams: { archived_at: null, description: null },
      weather_thresholds: {},
      weather_alert_roles: {},
    },
  );
  const app = contractApp({ handlers: [workforce], db });
  return { db, http: requests(app) };
}

describe("groups and chat", () => {
  it("serves groups, members, conversations, messages and the directory", async () => {
    const { http } = world();
    let r: Response;
    r = await success(http.get("/groups"));
    await expectContract(r, "workforceGroups.list");
    r = await success(http.get(`/groups/${GROUP}`));
    await expectContract(r, "workforceGroups.get");
    expect((await http.get(`/groups/${MISSING}`)).status).toBe(404);
    r = await success(http.post("/groups", { name: "Ushers", group_kind: "Custom" }));
    await expectContract(r, "workforceGroups.create");
    r = await success(http.patch(`/groups/${GROUP}`, { description: "Points" }));
    await expectContract(r, "workforceGroups.update");
    r = await success(http.post(`/groups/${GROUP}/archive`));
    await expectContract(r, "workforceGroups.archive");
    r = await success(http.get("/group-members"));
    await expectContract(r, "workforceGroupMembers.list");
    r = await success(http.get(`/group-members/${GROUP_MEMBER}`));
    await expectContract(r, "workforceGroupMembers.get");
    r = await success(
      http.post("/group-members", {
        group_id: GROUP,
        membership_id: OTHER,
        group_role: "Member",
      }),
    );
    await expectContract(r, "workforceGroupMembers.create");
    r = await success(http.delete(`/group-members/${GROUP_MEMBER}`));
    await expectContract(r, "workforceGroupMembers.delete");

    r = await success(http.get("/conversations"));
    await expectContract(r, "conversations.list");
    r = await success(http.get(`/conversations/${CONVERSATION}`));
    await expectContract(r, "conversations.get");
    r = await success(http.post("/conversations/start-direct", { other_membership_id: OTHER }));
    await expectContract(r, "conversations.startDirect");
    r = await success(http.post(`/conversations/${CONVERSATION}/mark-read`, { muted: false }));
    await expectContract(r, "conversations.markRead");
    r = await success(http.get(`/conversations/${CONVERSATION}/read-receipts`));
    await expectContract(r, "conversations.readReceipts");

    r = await success(http.get("/chat-messages"));
    await expectContract(r, "chatMessages.list");
    r = await success(http.get(`/chat-messages/${MESSAGE}`));
    await expectContract(r, "chatMessages.get");
    r = await success(
      http.post("/chat-messages", {
        conversation_id: CONVERSATION,
        message_kind: "Text",
        body: "On my way.",
      }),
    );
    await expectContract(r, "chatMessages.create");
    const refused = await http.post("/chat-messages", {
      conversation_id: CONVERSATION,
      message_kind: "Text",
      body: "refuse",
    });
    expect(refused.status).toBe(422);
    r = await success(http.patch(`/chat-messages/${MESSAGE}`, { body: "Points are down." }));
    await expectContract(r, "chatMessages.update");
    r = await success(http.delete(`/chat-messages/${MESSAGE}`));
    await expectContract(r, "chatMessages.delete");
    r = await success(http.get("/directory-entries/search?q=frank&on_site=true"));
    await expectContract(r, "directoryEntries.search");
  });
});

describe("feed, polls, surveys and recognition", () => {
  it("serves posts and their actions", async () => {
    const { http } = world();
    let r: Response;
    r = await success(http.get("/feed-posts"));
    await expectContract(r, "feedPosts.list");
    r = await success(http.get(`/feed-posts/${POST}`));
    await expectContract(r, "feedPosts.get");
    r = await success(
      http.post("/feed-posts", {
        post_kind: "Update",
        body: "Load-in at 06:00.",
        audience_kind: "Organization",
        requires_acknowledgment: false,
        reactions_enabled: true,
        comments_enabled: true,
        publish_at: T,
      }),
    );
    await expectContract(r, "feedPosts.create");
    r = await success(
      http.post("/feed-posts", {
        post_kind: "Announcement",
        body: "Production meeting at 14:00.",
        audience_kind: "Department",
        department_code: "5000",
        requires_acknowledgment: true,
        reactions_enabled: true,
        comments_enabled: true,
        publish_at: T,
      }),
    );
    await expectContract(r, "feedPosts.create");
    r = await success(
      http.post("/feed-posts/create-poll", {
        body: "Pick",
        question: "Meal?",
        options: ["Tacos", "Pasta"],
      }),
    );
    await expectContract(r, "feedPosts.createPoll");
    r = await success(http.patch(`/feed-posts/${POST}`, { comments_enabled: false }));
    await expectContract(r, "feedPosts.update");
    r = await success(http.post(`/feed-posts/${POST}/pin`, { pinned: true }));
    await expectContract(r, "feedPosts.pin");
    r = await success(http.post(`/feed-posts/${POST}/acknowledge`));
    await expectContract(r, "feedPosts.acknowledge");
    r = await success(http.post(`/feed-posts/${POST}/react`, { reaction_code: "heart" }));
    await expectContract(r, "feedPosts.react");
    expect((await http.post(`/feed-posts/${POST}/react`, { reaction_code: "eyes" })).status).toBe(
      422,
    );
    r = await success(http.get(`/feed-posts/${POST}/acknowledgments`));
    await expectContract(r, "feedPosts.acknowledgments");
    r = await success(http.post(`/feed-posts/${POST}/hide`, { reason: "Wrong project." }));
    await expectContract(r, "feedPosts.hide");

    r = await success(http.get("/polls"));
    await expectContract(r, "polls.list");
    r = await success(http.get(`/polls/${POLL}`));
    await expectContract(r, "polls.get");
    r = await success(http.post(`/polls/${POLL}/vote`, { option_ids: [OPTION] }));
    await expectContract(r, "polls.vote");
    r = await success(http.get(`/polls/${POLL}/results`));
    await expectContract(r, "polls.results");

    r = await success(http.get("/surveys"));
    await expectContract(r, "surveys.list");
    r = await success(http.get(`/surveys/${SURVEY}`));
    await expectContract(r, "surveys.get");
    r = await success(
      http.post("/surveys/draft", {
        title: "Pulse",
        questions: [{ prompt: "Safe?", kind: "Scale", scale_max: 5 }],
      }),
    );
    await expectContract(r, "surveys.draft");
    r = await success(
      http.post(`/surveys/${SURVEY}/transition`, {
        expected_state: "Draft",
        to_state: "Open",
        reason: "Ready.",
      }),
    );
    await expectContract(r, "surveys.transition");
    r = await success(http.post(`/surveys/${SURVEY}/respond`, { answers: { [QUESTION]: 4 } }));
    await expectContract(r, "surveys.respond");
    r = await success(http.get(`/surveys/${SURVEY}/results`));
    await expectContract(r, "surveys.results");
    r = await success(http.get("/survey-questions"));
    await expectContract(r, "surveyQuestions.list");
    r = await success(http.get(`/survey-questions/${QUESTION}`));
    await expectContract(r, "surveyQuestions.get");

    r = await success(http.get("/recognitions"));
    await expectContract(r, "recognitions.list");
    r = await success(http.get(`/recognitions/${RECOGNITION}`));
    await expectContract(r, "recognitions.get");
    r = await success(
      http.post("/recognitions", { to_membership_id: OTHER, message: "Great work." }),
    );
    await expectContract(r, "recognitions.create");
  });
});

describe("events and forms", () => {
  it("serves events with RSVP and check-in, and forms with submissions", async () => {
    const { http } = world();
    let r: Response;
    r = await success(http.get("/workforce-events"));
    await expectContract(r, "workforceEvents.list");
    r = await success(http.get(`/workforce-events/${EVENT}`));
    await expectContract(r, "workforceEvents.get");
    r = await success(
      http.post("/workforce-events", {
        event_kind: "Meeting",
        title: "Leads sync",
        audience_kind: "Organization",
        starts_at: T,
        ends_at: "2026-10-01T13:00:00.000Z",
        rsvp_required: true,
      }),
    );
    await expectContract(r, "workforceEvents.create");
    r = await success(http.patch(`/workforce-events/${EVENT}`, { title: "Safety brief 2" }));
    await expectContract(r, "workforceEvents.update");
    r = await success(http.post(`/workforce-events/${EVENT}/rsvp`, { response: "Going" }));
    await expectContract(r, "workforceEvents.rsvp");
    r = await success(http.post(`/workforce-events/${EVENT}/check-in`, { method: "Self" }));
    await expectContract(r, "workforceEvents.checkIn");
    r = await success(http.post(`/workforce-events/${EVENT}/cancel`, { reason: "Rain." }));
    await expectContract(r, "workforceEvents.cancel");
    r = await success(http.get("/event-rsvps"));
    await expectContract(r, "eventRsvps.list");
    r = await success(http.get(`/event-rsvps/${RSVP}`));
    await expectContract(r, "eventRsvps.get");
    r = await success(http.get("/event-check-ins"));
    await expectContract(r, "eventCheckIns.list");
    r = await success(http.get(`/event-check-ins/${CHECK_IN}`));
    await expectContract(r, "eventCheckIns.get");

    r = await success(http.get("/form-templates"));
    await expectContract(r, "formTemplates.list");
    r = await success(http.get(`/form-templates/${TEMPLATE}`));
    await expectContract(r, "formTemplates.get");
    r = await success(
      http.post("/form-templates", {
        name: "Handover",
        record_kind: "Document",
        fields: [{ key: "notes", label: "Notes", kind: "text" }],
        requires_signature: false,
        requires_location: false,
      }),
    );
    await expectContract(r, "formTemplates.create");
    r = await success(http.patch(`/form-templates/${TEMPLATE}`, { description: "Before lifts." }));
    await expectContract(r, "formTemplates.update");
    r = await success(http.post(`/form-templates/${TEMPLATE}/publish`));
    await expectContract(r, "formTemplates.publish");
    r = await success(http.post(`/form-templates/${TEMPLATE}/retire`, { reason: "Replaced." }));
    await expectContract(r, "formTemplates.retire");
    r = await success(http.get("/form-submissions"));
    await expectContract(r, "formSubmissions.list");
    r = await success(http.get(`/form-submissions/${SUBMISSION}`));
    await expectContract(r, "formSubmissions.get");
    r = await success(
      http.post("/form-submissions", {
        form_template_id: TEMPLATE,
        answers: { ok: true },
        latitude: 25.7,
        longitude: -80.1,
        signer_name: "Frank",
        signature_path: "o/s.png",
      }),
    );
    await expectContract(r, "formSubmissions.create");
    r = await success(http.post(`/form-submissions/${SUBMISSION}/decide`, { approve: true }));
    await expectContract(r, "formSubmissions.decide");
  });
});

describe("training and handbook", () => {
  it("serves courses, lessons, quizzes, completions, the handbook and knowledge sources", async () => {
    const { http } = world();
    let r: Response;
    r = await success(http.get("/training-courses"));
    await expectContract(r, "trainingCourses.list");
    r = await success(http.get(`/training-courses/${COURSE}`));
    await expectContract(r, "trainingCourses.get");
    r = await success(
      http.post("/training-courses", {
        title: "Fall protection",
        pass_percent: 80,
        validity_days: 365,
        estimated_minutes: 15,
      }),
    );
    await expectContract(r, "trainingCourses.create");
    r = await success(http.patch(`/training-courses/${COURSE}`, { summary: "Slings." }));
    await expectContract(r, "trainingCourses.update");
    r = await success(http.post(`/training-courses/${COURSE}/publish`));
    await expectContract(r, "trainingCourses.publish");
    r = await success(
      http.post(`/training-courses/${COURSE}/assign`, {
        membership_ids: [OTHER],
        due_on: "2026-10-20",
      }),
    );
    await expectContract(r, "trainingCourses.assign");
    r = await success(
      http.post(`/training-courses/${COURSE}/complete`, { answers: { [QUIZ_QUESTION]: 1 } }),
    );
    await expectContract(r, "trainingCourses.complete");
    r = await success(http.post(`/training-courses/${COURSE}/retire`, { reason: "Old." }));
    await expectContract(r, "trainingCourses.retire");
    r = await success(http.get("/training-lessons"));
    await expectContract(r, "trainingLessons.list");
    r = await success(http.get(`/training-lessons/${LESSON}`));
    await expectContract(r, "trainingLessons.get");
    r = await success(
      http.post("/training-lessons", {
        training_course_id: COURSE,
        position: 2,
        title: "Shackles",
        lesson_kind: "Reading",
        body: "Pin them.",
      }),
    );
    await expectContract(r, "trainingLessons.create");
    r = await success(http.patch(`/training-lessons/${LESSON}`, { title: "Slings 101" }));
    await expectContract(r, "trainingLessons.update");
    r = await success(http.post(`/training-lessons/${LESSON}/complete`));
    await expectContract(r, "trainingLessons.complete");
    r = await success(http.delete(`/training-lessons/${LESSON}`));
    await expectContract(r, "trainingLessons.delete");
    r = await success(http.get("/training-quiz-questions"));
    await expectContract(r, "trainingQuizQuestions.list");
    r = await success(http.get(`/training-quiz-questions/${QUIZ_QUESTION}`));
    await expectContract(r, "trainingQuizQuestions.get");
    r = await success(
      http.post("/training-quiz-questions", {
        training_lesson_id: LESSON,
        position: 2,
        prompt: "Who signs?",
        options: ["Anyone", "Head rigger"],
      }),
    );
    await expectContract(r, "trainingQuizQuestions.create");
    r = await success(
      http.patch(`/training-quiz-questions/${QUIZ_QUESTION}`, { prompt: "Inspect first?" }),
    );
    await expectContract(r, "trainingQuizQuestions.update");
    r = await success(http.get("/training-quiz-keys"));
    await expectContract(r, "trainingQuizKeys.list");
    r = await success(http.get(`/training-quiz-keys/${QUIZ_KEY}`));
    await expectContract(r, "trainingQuizKeys.get");
    r = await success(
      http.post("/training-quiz-keys", {
        training_quiz_question_id: QUIZ_QUESTION,
        correct_option: 2,
      }),
    );
    await expectContract(r, "trainingQuizKeys.create");
    r = await success(http.patch(`/training-quiz-keys/${QUIZ_KEY}`, { correct_option: 1 }));
    await expectContract(r, "trainingQuizKeys.update");
    r = await success(http.get("/training-assignments"));
    await expectContract(r, "trainingAssignments.list");
    r = await success(http.get(`/training-assignments/${ASSIGNMENT}`));
    await expectContract(r, "trainingAssignments.get");
    r = await success(http.delete(`/training-assignments/${ASSIGNMENT}`));
    await expectContract(r, "trainingAssignments.delete");
    r = await success(http.get("/training-completions"));
    await expectContract(r, "trainingCompletions.list");
    r = await success(http.get(`/training-completions/${COMPLETION}`));
    await expectContract(r, "trainingCompletions.get");
    r = await success(http.post(`/training-completions/${COMPLETION}/issue-certification`));
    await expectContract(r, "trainingCompletions.issueCertification");

    r = await success(http.get("/handbook-sections"));
    await expectContract(r, "handbookSections.list");
    r = await success(http.get(`/handbook-sections/${SECTION}`));
    await expectContract(r, "handbookSections.get");
    r = await success(http.post("/handbook-sections", { name: "PPE", position: 2 }));
    await expectContract(r, "handbookSections.create");
    r = await success(http.patch(`/handbook-sections/${SECTION}`, { position: 3 }));
    await expectContract(r, "handbookSections.update");
    r = await success(http.get("/handbook-articles"));
    await expectContract(r, "handbookArticles.list");
    r = await success(http.get(`/handbook-articles/${ARTICLE}`));
    await expectContract(r, "handbookArticles.get");
    r = await success(
      http.post("/handbook-articles", {
        title: "Hard hats",
        body: "Wear them.",
        is_mandatory: false,
      }),
    );
    await expectContract(r, "handbookArticles.create");
    r = await success(
      http.patch(`/handbook-articles/${ARTICLE}`, { body: "Wear protection within 10 m." }),
    );
    await expectContract(r, "handbookArticles.update");
    r = await success(
      http.post(`/handbook-articles/${ARTICLE}/publish`, { change_summary: "Distance." }),
    );
    await expectContract(r, "handbookArticles.publish");
    r = await success(http.post(`/handbook-articles/${ARTICLE}/acknowledge`));
    await expectContract(r, "handbookArticles.acknowledge");
    r = await success(http.post(`/handbook-articles/${ARTICLE}/archive`));
    await expectContract(r, "handbookArticles.archive");
    r = await success(http.get("/knowledge-sources/search?q=hearing"));
    await expectContract(r, "knowledgeSources.search");
  });
});

describe("help desk and site operations", () => {
  it("serves teams, requests, occupancy, weather, door check-in and lost and found", async () => {
    const { http } = world();
    let r: Response;
    r = await success(http.get("/help-desk-teams"));
    await expectContract(r, "helpDeskTeams.list");
    r = await success(http.get(`/help-desk-teams/${TEAM}`));
    await expectContract(r, "helpDeskTeams.get");
    r = await success(
      http.post("/help-desk-teams", {
        name: "Facilities",
        team_kind: "Facilities",
        first_response_hours: 8,
      }),
    );
    await expectContract(r, "helpDeskTeams.create");
    r = await success(http.patch(`/help-desk-teams/${TEAM}`, { first_response_hours: 2 }));
    await expectContract(r, "helpDeskTeams.update");
    r = await success(http.get("/help-desk-team-members"));
    await expectContract(r, "helpDeskTeamMembers.list");
    r = await success(http.get(`/help-desk-team-members/${TEAM_MEMBER}`));
    await expectContract(r, "helpDeskTeamMembers.get");
    r = await success(
      http.post("/help-desk-team-members", { help_desk_team_id: TEAM, membership_id: OTHER }),
    );
    await expectContract(r, "helpDeskTeamMembers.create");
    r = await success(http.delete(`/help-desk-team-members/${TEAM_MEMBER}`));
    await expectContract(r, "helpDeskTeamMembers.delete");
    r = await success(http.get("/help-desk-requests"));
    await expectContract(r, "helpDeskRequests.list");
    r = await success(http.get(`/help-desk-requests/${TICKET}`));
    await expectContract(r, "helpDeskRequests.get");
    r = await success(
      http.post("/help-desk-requests", {
        help_desk_team_id: TEAM,
        category: "Access",
        severity: "Severity 3",
        subject: "Tablet",
        body: "Blank.",
      }),
    );
    await expectContract(r, "helpDeskRequests.create");
    r = await success(
      http.post(`/help-desk-requests/${TICKET}/assign`, { assignee_membership_id: MEMBER }),
    );
    await expectContract(r, "helpDeskRequests.assign");
    r = await success(http.post(`/help-desk-requests/${TICKET}/answer`, { body: "On it." }));
    await expectContract(r, "helpDeskRequests.answer");
    r = await success(
      http.post(`/help-desk-requests/${TICKET}/transition`, {
        expected_state: "Open",
        to_state: "Resolved",
        reason: "Done.",
      }),
    );
    await expectContract(r, "helpDeskRequests.transition");
    r = await success(http.post(`/help-desk-teams/${TEAM}/archive`));
    await expectContract(r, "helpDeskTeams.archive");

    r = await success(http.get("/occupancy-counters"));
    await expectContract(r, "occupancyCounters.list");
    r = await success(http.get(`/occupancy-counters/${COUNTER}`));
    await expectContract(r, "occupancyCounters.get");
    r = await success(
      http.post("/occupancy-counters/set-up", {
        project_id: PROJECT,
        name: "Deck",
        permitted_load: 40,
      }),
    );
    await expectContract(r, "occupancyCounters.setUp");
    r = await success(
      http.post(`/occupancy-counters/${COUNTER}/count`, { delta: 1, door: "Gate A" }),
    );
    await expectContract(r, "occupancyCounters.count");
    r = await success(http.post(`/occupancy-counters/${COUNTER}/close`));
    await expectContract(r, "occupancyCounters.close");
    r = await success(http.get("/weather-thresholds"));
    await expectContract(r, "weatherThresholds.list");
    r = await success(http.get(`/weather-thresholds/${THRESHOLD}`));
    await expectContract(r, "weatherThresholds.get");
    r = await success(
      http.post("/weather-thresholds", {
        project_id: PROJECT,
        hazard: "Lightning",
        alert_level: "Evacuate",
        threshold_value: 8,
        unit: "mi",
        comparison: "At or Below",
        source_note: "Plan 4.3",
      }),
    );
    await expectContract(r, "weatherThresholds.create");
    r = await success(http.patch(`/weather-thresholds/${THRESHOLD}`, { threshold_value: 32 }));
    await expectContract(r, "weatherThresholds.update");
    r = await success(http.get("/weather-alert-roles"));
    await expectContract(r, "weatherAlertRoles.list");
    r = await success(http.get(`/weather-alert-roles/${ALERT_ROLE}`));
    await expectContract(r, "weatherAlertRoles.get");
    r = await success(
      http.post("/weather-alert-roles", {
        project_id: PROJECT,
        alert_level: "Monitor",
        role_code: "5000.01.01",
      }),
    );
    await expectContract(r, "weatherAlertRoles.create");
    r = await success(http.delete(`/weather-alert-roles/${ALERT_ROLE}`));
    await expectContract(r, "weatherAlertRoles.delete");
    r = await success(http.get("/weather-readings"));
    await expectContract(r, "weatherReadings.list");
    r = await success(http.get(`/weather-readings/${READING}`));
    await expectContract(r, "weatherReadings.get");
    r = await success(
      http.post("/weather-readings", {
        project_id: PROJECT,
        hazard: "Wind",
        reading_value: 33,
        observed_at: T,
      }),
    );
    await expectContract(r, "weatherReadings.create");
    r = await success(http.get("/weather-alerts"));
    await expectContract(r, "weatherAlerts.list");
    r = await success(http.get(`/weather-alerts/${ALERT}`));
    await expectContract(r, "weatherAlerts.get");
    r = await success(http.get("/guest-check-ins"));
    await expectContract(r, "guestCheckIns.list");
    r = await success(http.get(`/guest-check-ins/${GUEST_CHECK_IN}`));
    await expectContract(r, "guestCheckIns.get");
    r = await success(
      http.post("/guest-check-ins", {
        guest_list_entry_id: ENTRY,
        plus_ones_admitted: 1,
        door: "Gate A",
      }),
    );
    await expectContract(r, "guestCheckIns.create");
    r = await success(http.get(`/guest-check-ins/door-list?project_id=${PROJECT}&q=jordan`));
    await expectContract(r, "guestCheckIns.doorList");
    r = await success(http.get("/lost-found-items"));
    await expectContract(r, "lostFoundItems.list");
    r = await success(http.get(`/lost-found-items/${ITEM}`));
    await expectContract(r, "lostFoundItems.get");
    r = await success(
      http.post("/lost-found-items", {
        project_id: PROJECT,
        category: "Keys",
        description: "Ring.",
        found_at: T,
        found_location: "Gate",
      }),
    );
    await expectContract(r, "lostFoundItems.create");
    r = await success(http.patch(`/lost-found-items/${ITEM}`, { storage_location: "Locker 4" }));
    await expectContract(r, "lostFoundItems.update");
    r = await success(
      http.post(`/lost-found-items/${ITEM}/claim`, {
        claimant_name: "Riley Park",
        claimant_contact: "555 0142",
        proof_description: "Card.",
      }),
    );
    await expectContract(r, "lostFoundItems.claim");
    r = await success(http.post(`/lost-found-items/${ITEM}/dispose`, { reason: "Unclaimed." }));
    await expectContract(r, "lostFoundItems.dispose");
    r = await success(http.get("/lost-found-claims"));
    await expectContract(r, "lostFoundClaims.list");
    r = await success(http.get(`/lost-found-claims/${CLAIM}`));
    await expectContract(r, "lostFoundClaims.get");
    r = await success(http.post(`/lost-found-claims/${CLAIM}/settle`, { returned: true }));
    await expectContract(r, "lostFoundClaims.settle");
  });
});
