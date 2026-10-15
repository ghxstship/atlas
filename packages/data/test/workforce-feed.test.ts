import { describe, expect, it } from "vitest";
import {
  acknowledgeFeedPost,
  createFeedPost,
  createSurvey,
  feedOrder,
  getPollResults,
  getRecognitionConsent,
  getRecognitionCount,
  getSurveyResults,
  hideFeedPost,
  listAcknowledgmentStatus,
  listFeed,
  listRecognitions,
  listSurveys,
  reactToFeedPost,
  recognize,
  respondToSurvey,
  responseRate,
  setRecognitionConsent,
  surveyProblems,
  transitionSurvey,
  updateFeedPost,
  votePercent,
  voteInPoll,
} from "../src/workforce-feed.ts";
import { errorResponse, okResponse } from "./fake-client.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const post = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  post_kind: "Announcement",
  title: "Wristbands",
  body: "Colors change Friday.",
  audience_kind: "Organization",
  project_id: null,
  team_id: null,
  role_id: null,
  group_id: null,
  author_membership_id: "m1",
  pinned_at: null,
  requires_acknowledgment: true,
  reactions_enabled: true,
  comments_enabled: true,
  publish_at: "2026-10-01T00:00:00Z",
  hidden_at: null,
  hidden_reason: null,
  author: { id: "m1", person_id: "p1", person: { full_name: "Carol" } },
  feed_reactions: [
    { membership_id: "m2", reaction_code: "heart", deleted_at: null },
    { membership_id: "m3", reaction_code: "heart", deleted_at: null },
    { membership_id: "m2", reaction_code: "check", deleted_at: "x" },
  ],
  polls: [],
  ...extra,
});

describe("feed", () => {
  it("lists posts pinned first with reactions, acknowledgments and poll votes", async () => {
    const { db } = moduleClient({
      "from:feed_posts": [
        okResponse([
          post("p1"),
          post("p2", {
            pinned_at: "2026-09-01T00:00:00Z",
            publish_at: "2026-09-01T00:00:00Z",
            post_kind: "Poll",
            polls: [
              {
                id: "poll1",
                question: "Meal?",
                allows_multiple: false,
                closes_at: null,
                poll_options: [
                  { id: "o2", position: 2, label: "Pasta", deleted_at: null },
                  { id: "o1", position: 1, label: "Tacos", deleted_at: null },
                ],
              },
            ],
          }),
        ]),
        okResponse([]),
      ],
      "from:feed_acknowledgments": [okResponse([{ feed_post_id: "p1" }])],
      "from:poll_votes": [okResponse([{ poll_id: "poll1", poll_option_id: "o1" }])],
    });
    const feed = await listFeed(db, "o1", ["m2"]);
    expect(feed.ok && feed.data.map((p) => p.id)).toEqual(["p2", "p1"]);
    const [pinned, plain] = feed.ok ? feed.data : [];
    expect(plain?.reactions).toEqual({ heart: 2 });
    expect(plain?.myReactions).toEqual(["heart"]);
    expect(plain?.acknowledgedByMe).toBe(true);
    expect(pinned?.poll?.options.map((o) => o.label)).toEqual(["Tacos", "Pasta"]);
    expect(pinned?.poll?.myChoices).toEqual(["o1"]);
    const empty = await listFeed(db, "o1", ["m2"], { projectId: "pr1" });
    expect(empty.ok && empty.data).toEqual([]);
  });

  it("orders pinned before newest", () => {
    const a = { pinnedAt: null, publishAt: "2026-10-02" };
    const b = { pinnedAt: "x", publishAt: "2026-01-01" };
    const c = { pinnedAt: null, publishAt: "2026-10-03" };
    expect([a, b, c].sort(feedOrder)).toEqual([b, c, a]);
  });

  it("writes posts through the RPCs", async () => {
    const { db, calls } = moduleClient({
      "rpc:create_feed_post": [okResponse("p1")],
      "rpc:update_feed_post": [okResponse("p1")],
      "rpc:hide_feed_post": [okResponse("p1")],
      "rpc:acknowledge_feed_post": [
        okResponse("a1"),
        errorResponse("XR001", "feed_post_no_acknowledgment: no", "feed_post_no_acknowledgment"),
      ],
      "rpc:react_to_feed_post": [okResponse(true)],
      "rpc:feed_acknowledgment_status": [
        okResponse([
          { membership_id: "m2", person_id: "p2", full_name: "Frank", acknowledged_at: null },
        ]),
      ],
      "rpc:vote_in_poll": [okResponse(1)],
      "rpc:poll_results": [
        okResponse([
          { poll_option_id: "o1", option_position: 1, label: "Tacos", votes: 2, voters: 3 },
        ]),
      ],
    });
    await createFeedPost(db, "o1", {
      kind: "Poll",
      body: "Pick",
      audience: { kind: "Project", projectId: "pr1" },
      poll: { question: "Meal?", options: ["Tacos", "Pasta"] },
    });
    expect(calls[0]?.steps[0]?.[1][0]).toEqual({
      p_org_id: "o1",
      p_post_kind: "Poll",
      p_body: "Pick",
      p_poll: { question: "Meal?", options: ["Tacos", "Pasta"], allows_multiple: false },
      p_audience_kind: "Project",
      p_project_id: "pr1",
    });
    expect((await updateFeedPost(db, "p1", { pinned: true })).ok).toBe(true);
    expect((await hideFeedPost(db, "p1", "Wrong project")).ok).toBe(true);
    expect((await acknowledgeFeedPost(db, "p1")).ok).toBe(true);
    const refused = await acknowledgeFeedPost(db, "p1");
    expect(!refused.ok && refused.error.kind).toBe("refusal");
    expect(await reactToFeedPost(db, "p1", "heart", true)).toEqual({ ok: true, data: true });
    const status = await listAcknowledgmentStatus(db, "p1");
    expect(status.ok && status.data[0]?.acknowledgedAt).toBeNull();
    expect(await voteInPoll(db, "poll1", ["o1"])).toEqual({ ok: true, data: 1 });
    const results = await getPollResults(db, "poll1");
    expect(
      results.ok && votePercent(results.data[0]?.votes ?? 0, results.data[0]?.voters ?? 0),
    ).toBe(67);
    expect(votePercent(1, 0)).toBe(0);
  });
});

describe("surveys", () => {
  it("lists surveys with questions and whether the viewer responded", async () => {
    const { db } = moduleClient({
      "from:surveys": [
        okResponse([
          {
            id: "s1",
            title: "Pulse",
            description: null,
            audience_kind: "Organization",
            project_id: null,
            team_id: null,
            role_id: null,
            group_id: null,
            author_membership_id: "m1",
            is_anonymous: true,
            min_responses: 3,
            survey_state: "Open",
            closes_at: null,
            created_at: "2026-10-01T00:00:00Z",
            survey_questions: [
              {
                id: "q2",
                position: 2,
                prompt: "Best?",
                question_kind: "Choice",
                choices: ["A", "B"],
                scale_max: null,
                is_required: true,
                deleted_at: null,
              },
              {
                id: "q1",
                position: 1,
                prompt: "Safe?",
                question_kind: "Scale",
                choices: null,
                scale_max: 5,
                is_required: true,
                deleted_at: null,
              },
            ],
          },
        ]),
      ],
      "from:survey_participations": [okResponse([{ survey_id: "s1" }])],
    });
    const surveys = await listSurveys(db, "o1", ["m2"]);
    expect(surveys.ok && surveys.data[0]?.questions.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(surveys.ok && surveys.data[0]?.respondedByMe).toBe(true);
  });

  it("checks questions, creates, opens, responds and reads results", async () => {
    expect(surveyProblems([])).toEqual(["questionCount"]);
    expect(surveyProblems([{ prompt: " ", kind: "Choice", choices: ["A"] }])).toEqual([
      "prompt:0",
      "choices:0",
    ]);
    const { db, calls } = moduleClient({
      "rpc:create_survey": [okResponse("s1")],
      "rpc:transition_survey": [okResponse("l1")],
      "rpc:respond_to_survey": [okResponse(null)],
      "rpc:survey_results": [
        okResponse({
          responses: 3,
          min_responses: 3,
          threshold_met: true,
          audience: 8,
          questions: [
            {
              question_id: "q1",
              position: 1,
              prompt: "Safe?",
              kind: "Scale",
              scale_max: 5,
              answered: 3,
              average: 3,
              counts: { "1": 0, "3": 3 },
              texts: null,
            },
          ],
        }),
      ],
    });
    const bad = await createSurvey(db, "o1", { title: "x", questions: [] });
    expect(!bad.ok && bad.error.kind).toBe("invalid");
    await createSurvey(db, "o1", {
      title: "Pulse",
      questions: [
        { prompt: "Safe?", kind: "Scale" },
        { prompt: "Best?", kind: "Choice", choices: ["A", "B"], required: false },
      ],
    });
    expect(calls[0]?.steps[0]?.[1][0]).toMatchObject({
      p_questions: [
        { prompt: "Safe?", kind: "Scale", scale_max: 5, required: true },
        { prompt: "Best?", kind: "Choice", choices: ["A", "B"], required: false },
      ],
    });
    expect((await transitionSurvey(db, "s1", "Draft", "Open", "Ready")).ok).toBe(true);
    expect(await respondToSurvey(db, "s1", { q1: 4 })).toEqual({ ok: true, data: { id: null } });
    const results = await getSurveyResults(db, "s1");
    expect(results.ok && results.data.questions[0]?.counts).toEqual({ "1": 0, "3": 3 });
    expect(results.ok && responseRate(results.data)).toBe(38);
    expect(responseRate({ responses: 1, audience: 0 })).toBeNull();
  });
});

describe("recognition", () => {
  it("lists, recognizes and handles consent", async () => {
    const { db, calls } = moduleClient({
      "from:recognitions": [
        okResponse([
          {
            id: "r1",
            from_membership_id: "m1",
            to_membership_id: "m2",
            project_id: null,
            shift_id: null,
            message: "Great",
            feed_post_id: "p1",
            created_at: "2026-10-01T00:00:00Z",
            giver: { person: { full_name: "Dave" } },
            receiver: { person: { full_name: "Frank" } },
          },
        ]),
      ],
      "rpc:recognize": [okResponse("r2")],
      "rpc:recognition_count": [okResponse(3), okResponse(null)],
      "from:consent_records": [
        okResponse({ id: "c1" }),
        okResponse([{ id: "c1" }]),
        okResponse({ id: "c1" }),
        okResponse([]),
      ],
    });
    const list = await listRecognitions(db, "o1");
    expect(list.ok && list.data[0]).toMatchObject({ fromName: "Dave", toName: "Frank" });
    await recognize(db, "o1", { toMembershipId: "m2", message: "Thanks", shiftId: "s1" });
    expect(calls[1]?.steps[0]?.[1][0]).toEqual({
      p_org_id: "o1",
      p_to_membership_id: "m2",
      p_message: "Thanks",
      p_shift_id: "s1",
    });
    expect(await getRecognitionCount(db, "o1", "p2")).toEqual({ ok: true, data: 3 });
    expect(await getRecognitionCount(db, "o1", "p2")).toEqual({ ok: true, data: null });
    expect((await setRecognitionConsent(db, "o1", "p2", true)).ok).toBe(true);
    expect(stepsOf(calls[4], "insert")[0]?.[0]).toMatchObject({
      purpose_code: "recognition_profile",
    });
    expect((await setRecognitionConsent(db, "o1", "p2", false)).ok).toBe(true);
    expect(await getRecognitionConsent(db, "o1", "p2")).toEqual({ ok: true, data: null });
  });
});
