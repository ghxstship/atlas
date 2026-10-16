import { describe, expect, it } from "vitest";
import {
  acknowledgeHandbookArticle,
  addQuizQuestion,
  addTrainingLesson,
  archiveHandbookArticle,
  assignTraining,
  completeTraining,
  completeTrainingLesson,
  createHandbookArticle,
  createHandbookSection,
  createTrainingCourse,
  handbookChanged,
  issueTrainingCertification,
  lessonProgress,
  listHandbookAcknowledgmentStatus,
  listHandbookArticles,
  listHandbookSections,
  listMyLessonProgress,
  listMyMandatoryReads,
  listTrainingAssignments,
  listTrainingCompletions,
  listTrainingCourses,
  publishHandbookArticle,
  publishTrainingCourse,
  removeTrainingLesson,
  retireTrainingCourse,
  searchKnowledgeSources,
  trainingStanding,
  updateHandbookArticle,
  updateTrainingCourse,
} from "../src/workforce-training.ts";
import {
  answerHelpDeskRequest,
  addHelpDeskTeamMember,
  archiveHelpDeskTeam,
  assignHelpDeskRequest,
  createHelpDeskTeam,
  listHelpDeskMessages,
  listHelpDeskRequests,
  listHelpDeskTeams,
  openHelpDeskRequest,
  removeHelpDeskTeamMember,
  responseOverdue,
  transitionHelpDeskRequest,
} from "../src/workforce-help-desk.ts";
import {
  addWeatherAlertRole,
  checkInGuest,
  claimLostItem,
  closeOccupancyCounter,
  createOccupancyCounter,
  disposeLostItem,
  doorTotals,
  getWeatherBoard,
  listDoorGuests,
  listLostItems,
  listOccupancyCounters,
  listOccupantLoadFactors,
  listProjectSpaces,
  logLostItem,
  occupancyLevel,
  occupancyPercent,
  recordOccupancyCount,
  recordWeatherReading,
  removeWeatherAlertRole,
  setWeatherThreshold,
  settleLostItemClaim,
  updateLostItem,
  weatherLevel,
} from "../src/workforce-site.ts";
import { okResponse } from "./fake-client.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const who = (name: string) => ({ person: { full_name: name } });
const id = (v: string) => okResponse({ id: v });

describe("training", () => {
  it("reads courses with ordered lessons and quiz questions", async () => {
    const { db } = moduleClient({
      "from:training_courses": [
        okResponse([
          {
            id: "c1",
            title: "Rigging",
            summary: null,
            role_code: null,
            certification_id: "cert1",
            gate_criterion_id: null,
            validity_days: 365,
            pass_percent: 80,
            estimated_minutes: 20,
            course_state: "Published",
            training_lessons: [
              {
                id: "l2",
                position: 2,
                title: "Quiz",
                lesson_kind: "Quiz",
                body: null,
                video_url: null,
                deleted_at: null,
                training_quiz_questions: [
                  {
                    id: "q1",
                    position: 1,
                    prompt: "Inspect?",
                    options: ["Yes", "No"],
                    deleted_at: null,
                  },
                ],
              },
              {
                id: "l1",
                position: 1,
                title: "Slings",
                lesson_kind: "Reading",
                body: "Inspect.",
                video_url: null,
                deleted_at: null,
                training_quiz_questions: [],
              },
              {
                id: "l3",
                position: 3,
                title: "Gone",
                lesson_kind: "Reading",
                body: "x",
                video_url: null,
                deleted_at: "x",
                training_quiz_questions: [],
              },
            ],
          },
        ]),
      ],
      "from:training_assignments": [
        okResponse([
          {
            id: "a1",
            training_course_id: "c1",
            membership_id: "m2",
            due_on: "2026-10-20",
            reason: null,
            membership: who("Frank"),
          },
        ]),
      ],
      "from:training_lesson_progress": [okResponse([{ training_lesson_id: "l1" }])],
      "from:training_completions": [
        okResponse([
          {
            id: "tc1",
            training_course_id: "c1",
            membership_id: "m2",
            score_percent: 50,
            passed: true,
            completed_at: "2026-10-01T00:00:00Z",
            expires_at: "2027-10-01T00:00:00Z",
            certificate_number: "TRN-0001",
            certification_holder_id: null,
            membership: who("Frank"),
          },
        ]),
      ],
    });
    const courses = await listTrainingCourses(db, "o1");
    const course = courses.ok ? courses.data[0] : undefined;
    expect(course?.lessons.map((l) => l.id)).toEqual(["l1", "l2"]);
    expect(course?.lessons[1]?.questions[0]?.options).toEqual(["Yes", "No"]);
    const assignments = await listTrainingAssignments(db, "o1");
    expect(assignments.ok && assignments.data[0]?.name).toBe("Frank");
    const progress = await listMyLessonProgress(db, ["m2"]);
    expect(progress.ok && course && lessonProgress(course, new Set(progress.data))).toBe(100);
    expect(course && lessonProgress(course, new Set())).toBe(0);
    expect(lessonProgress({ lessons: [] }, new Set())).toBe(100);
    const completions = await listTrainingCompletions(db, "o1");
    expect(completions.ok && trainingStanding(completions.data, new Date("2026-11-01"))).toBe(
      "current",
    );
    expect(completions.ok && trainingStanding(completions.data, new Date("2028-01-01"))).toBe(
      "expired",
    );
    expect(trainingStanding([])).toBe("none");
    expect(trainingStanding([{ passed: false, expiresAt: null, completedAt: "x" }])).toBe("failed");
  });

  it("writes courses, lessons, quizzes and completions", async () => {
    const { db, calls } = moduleClient({
      "from:training_courses": [id("c1"), id("c1")],
      "from:training_lessons": [id("l1"), id("l1")],
      "from:training_quiz_questions": [id("q1")],
      "from:training_quiz_keys": [id("k1")],
      "rpc:publish_training_course": [okResponse("x")],
      "rpc:retire_training_course": [okResponse("x")],
      "rpc:assign_training": [okResponse(2)],
      "rpc:complete_training_lesson": [okResponse("p1")],
      "rpc:complete_training": [okResponse("tc1")],
      "rpc:issue_training_certification": [okResponse("h1")],
    });
    expect((await createTrainingCourse(db, "o1", { title: "Rigging" })).ok).toBe(true);
    expect(stepsOf(calls[0], "insert")[0]?.[0]).toMatchObject({
      pass_percent: 80,
      validity_days: null,
    });
    expect((await updateTrainingCourse(db, "c1", { title: "Rigging", passPercent: 60 })).ok).toBe(
      true,
    );
    expect(
      (
        await addTrainingLesson(db, "c1", {
          position: 1,
          title: "Video",
          kind: "Video",
          videoUrl: "https://v",
        })
      ).ok,
    ).toBe(true);
    expect((await removeTrainingLesson(db, "l1")).ok).toBe(true);
    expect(
      await addQuizQuestion(db, "l2", {
        position: 1,
        prompt: "Inspect?",
        options: ["Yes", "No"],
        correctOption: 1,
      }),
    ).toEqual({ ok: true, data: { id: "q1" } });
    expect((await publishTrainingCourse(db, "c1")).ok).toBe(true);
    expect((await retireTrainingCourse(db, "c1", "Old")).ok).toBe(true);
    expect(await assignTraining(db, "c1", ["m1", "m2"], "2026-10-20")).toEqual({
      ok: true,
      data: 2,
    });
    expect((await completeTrainingLesson(db, "l1")).ok).toBe(true);
    expect((await completeTraining(db, "c1", { q1: 1 })).ok).toBe(true);
    expect((await issueTrainingCertification(db, "tc1")).ok).toBe(true);
  });
});

describe("handbook and assistant sources", () => {
  it("reads articles with their published version and acknowledgment", async () => {
    const { db } = moduleClient({
      "from:handbook_sections": [
        okResponse([{ id: "s1", name: "Site rules", position: 1 }]),
        id("s2"),
      ],
      "from:handbook_articles": [
        okResponse([
          {
            id: "a1",
            handbook_section_id: "s1",
            title: "Hearing",
            body: "Wear protection within 10 m.",
            is_mandatory: true,
            article_state: "Published",
            published_version: 2,
            published_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-01T00:00:00Z",
            handbook_article_versions: [
              { version: 1, title: "Hearing", body: "Wear protection.", change_summary: null },
              {
                version: 2,
                title: "Hearing",
                body: "Wear protection within 10 m.",
                change_summary: "Distance",
              },
            ],
          },
        ]),
        id("a2"),
        id("a2"),
        id("a2"),
      ],
      "from:handbook_acknowledgments": [okResponse([{ handbook_article_id: "a1", version: 2 }])],
      "rpc:publish_handbook_article": [okResponse(3)],
      "rpc:acknowledge_handbook_article": [okResponse("k1")],
      "rpc:handbook_acknowledgment_status": [
        okResponse([{ membership_id: "m1", full_name: "Frank", acknowledged_at: null }]),
      ],
      "rpc:my_mandatory_reads": [
        okResponse([
          { handbook_article_id: "a1", title: "Hearing", version: 2, published_at: null },
        ]),
      ],
      "rpc:assistant_knowledge_sources": [
        okResponse([
          {
            source_kind: "Handbook",
            source_id: "a1",
            title: "Hearing",
            version: 2,
            excerpt: "Wear",
            route: "/o/knowledge/handbook?peek=a1",
            rank: 0.5,
          },
        ]),
      ],
    });
    expect((await listHandbookSections(db, "o1")).ok).toBe(true);
    expect((await createHandbookSection(db, "o1", "PPE", 2)).ok).toBe(true);
    const articles = await listHandbookArticles(db, "o1", ["m1"]);
    const article = articles.ok ? articles.data[0] : undefined;
    expect(article?.published?.changeSummary).toBe("Distance");
    expect(article?.acknowledgedByMe).toBe(true);
    expect(article && handbookChanged(article)).toBe(false);
    expect(article && handbookChanged({ ...article, body: "Changed" })).toBe(true);
    expect(handbookChanged({ title: "x", body: "y", published: null })).toBe(true);
    expect((await createHandbookArticle(db, "o1", { title: "PPE", body: "Hats." })).ok).toBe(true);
    expect((await updateHandbookArticle(db, "a2", { title: "PPE", body: "Hard hats." })).ok).toBe(
      true,
    );
    expect((await archiveHandbookArticle(db, "a2")).ok).toBe(true);
    expect(await publishHandbookArticle(db, "a1", "Distance")).toEqual({ ok: true, data: 3 });
    expect((await acknowledgeHandbookArticle(db, "a1")).ok).toBe(true);
    const status = await listHandbookAcknowledgmentStatus(db, "a1");
    expect(status.ok && status.data[0]?.acknowledgedAt).toBeNull();
    const reads = await listMyMandatoryReads(db, "o1");
    expect(reads.ok && reads.data[0]?.version).toBe(2);
    const sources = await searchKnowledgeSources(db, "o1", "hearing");
    expect(sources.ok && sources.data[0]).toMatchObject({
      kind: "Handbook",
      route: "/o/knowledge/handbook?peek=a1",
    });
  });
});

describe("help desk", () => {
  it("reads teams and requests and works a request", async () => {
    const { db, calls } = moduleClient({
      "from:help_desk_teams": [
        okResponse([
          {
            id: "t1",
            name: "IT Desk",
            team_kind: "IT",
            description: null,
            first_response_hours: 4,
            archived_at: null,
            help_desk_team_members: [
              { id: "tm1", membership_id: "m1", deleted_at: null, membership: who("Dave") },
              { id: "tm2", membership_id: "m2", deleted_at: "x", membership: who("Old") },
            ],
          },
        ]),
        id("t2"),
        id("t2"),
      ],
      "from:help_desk_team_members": [id("tm3"), id("tm3")],
      "from:support_tickets": [
        okResponse([
          {
            id: "r1",
            ticket_number: "SUP-0001",
            help_desk_team_id: "t1",
            category: "Access",
            severity: "Severity 3",
            subject: "Tablet",
            body: "Blank screen",
            ticket_state: "Open",
            membership_id: "m3",
            assignee_membership_id: null,
            help_desk_response_due_at: "2026-10-01T12:00:00Z",
            first_responded_at: null,
            created_at: "2026-10-01T08:00:00Z",
            requester: who("Frank"),
            assignee: null,
          },
        ]),
      ],
      "from:support_ticket_messages": [
        okResponse([
          {
            id: "x1",
            author_membership_id: "m1",
            body: "On it",
            created_at: "2026-10-01T09:00:00Z",
            author: who("Dave"),
          },
        ]),
      ],
      "rpc:open_help_desk_request": [okResponse("r2")],
      "rpc:assign_help_desk_request": [okResponse("r1")],
      "rpc:answer_help_desk_request": [okResponse("x2")],
      "rpc:transition_help_desk_request": [okResponse("l1")],
    });
    const teams = await listHelpDeskTeams(db, "o1");
    expect(teams.ok && teams.data[0]?.members.map((m) => m.name)).toEqual(["Dave"]);
    expect(
      (
        await createHelpDeskTeam(db, "o1", {
          name: "Facilities",
          kind: "Facilities",
          firstResponseHours: 8,
        })
      ).ok,
    ).toBe(true);
    expect((await archiveHelpDeskTeam(db, "t2")).ok).toBe(true);
    expect((await addHelpDeskTeamMember(db, "t1", "m4")).ok).toBe(true);
    expect((await removeHelpDeskTeamMember(db, "tm3")).ok).toBe(true);
    const requests = await listHelpDeskRequests(db, "o1");
    const req = requests.ok ? requests.data[0] : undefined;
    expect(req).toMatchObject({ number: "SUP-0001", requesterName: "Frank", assigneeName: null });
    expect(req && responseOverdue(req, new Date("2026-10-01T13:00:00Z"))).toBe(true);
    expect(req && responseOverdue(req, new Date("2026-10-01T10:00:00Z"))).toBe(false);
    expect((await listHelpDeskMessages(db, "r1")).ok).toBe(true);
    await openHelpDeskRequest(db, "o1", {
      teamId: "t1",
      category: "Access",
      subject: "Tablet",
      body: "Blank",
    });
    expect(calls.find((c) => c.target === "rpc:open_help_desk_request")?.steps[0]?.[1][0]).toEqual({
      p_org_id: "o1",
      p_help_desk_team_id: "t1",
      p_category: "Access",
      p_subject: "Tablet",
      p_body: "Blank",
    });
    expect((await assignHelpDeskRequest(db, "r1", "m1")).ok).toBe(true);
    expect((await answerHelpDeskRequest(db, "r1", "On it")).ok).toBe(true);
    expect((await transitionHelpDeskRequest(db, "r1", "Open", "Resolved", "Done")).ok).toBe(true);
  });
});

describe("site operations", () => {
  it("handles occupancy counters and load factors", async () => {
    const { db } = moduleClient({
      "from:occupancy_counters": [
        okResponse([
          {
            id: "c1",
            project_id: "pr1",
            space_id: "s1",
            name: "Floor",
            load_basis: "Occupant Load Factor",
            metric_item: "Assembly",
            permitted_load: 100,
            current_count: 85,
            alert_level_percent: 80,
            closed_at: null,
          },
        ]),
      ],
      "rpc:create_occupancy_counter": [okResponse("c2")],
      "rpc:close_occupancy_counter": [okResponse("c2")],
      "rpc:record_occupancy_count": [okResponse(86)],
      "xpms:from:dim_metric": [
        okResponse([
          { item: "Assembly - standing space", value_numeric: 5, qualifier: "net", ordinal: 1 },
          { item: "Exits required", value_numeric: 4, qualifier: "IBC", ordinal: 2 },
        ]),
      ],
      "from:projects": [okResponse({ venue_id: "v1" }), okResponse({ venue_id: null })],
      "from:spaces": [okResponse([{ id: "s1", name: "Floor", area_sq_ft: 500, capacity: null }])],
    });
    const counters = await listOccupancyCounters(db, "pr1");
    const c = counters.ok ? counters.data[0] : undefined;
    expect(c && occupancyPercent(c)).toBe(85);
    expect(c && occupancyLevel(c)).toBe(80);
    expect(occupancyLevel({ count: 95, permittedLoad: 100 })).toBe(90);
    expect(occupancyLevel({ count: 1, permittedLoad: 0 })).toBe(0);
    expect(occupancyPercent({ count: 1, permittedLoad: 0 })).toBe(0);
    expect(
      (await createOccupancyCounter(db, { projectId: "pr1", name: "Deck", spaceId: "s2" })).ok,
    ).toBe(true);
    expect((await closeOccupancyCounter(db, "c2")).ok).toBe(true);
    expect(await recordOccupancyCount(db, "c1", 1, "Gate A")).toEqual({ ok: true, data: 86 });
    const factors = await listOccupantLoadFactors(db);
    expect(factors.ok && factors.data.map((f) => f.item)).toEqual(["Assembly - standing space"]);
    const spaces = await listProjectSpaces(db, "pr1");
    expect(spaces.ok && spaces.data[0]?.areaSqFt).toBe(500);
    expect(await listProjectSpaces(db, "pr2")).toEqual({ ok: true, data: [] });
  });

  it("handles weather thresholds, readings and levels", async () => {
    const { db, calls } = moduleClient({
      "from:weather_thresholds": [
        okResponse([
          {
            id: "w1",
            hazard: "Wind",
            alert_level: "Restrict",
            threshold_value: 30,
            unit: "mph",
            source_note: "Plan 4.2",
          },
        ]),
        okResponse(["w1"].map((x) => ({ id: x }))),
        id("w1"),
        okResponse([]),
        id("w2"),
      ],
      "from:weather_readings": [
        okResponse([
          {
            id: "r1",
            hazard: "Wind",
            reading_value: 33,
            observed_at: "2026-10-01T00:00:00Z",
            recorder: who("Frank"),
          },
        ]),
      ],
      "from:weather_alerts": [
        okResponse([
          {
            id: "a1",
            hazard: "Wind",
            alert_level: "Restrict",
            issued_at: "2026-10-01T00:00:00Z",
            cleared_at: null,
          },
        ]),
      ],
      "from:weather_alert_roles": [
        okResponse([{ id: "ar1", alert_level: "Evacuate", role_code: "1000.01.01" }]),
        id("ar2"),
        id("ar2"),
      ],
      "rpc:record_weather_reading": [okResponse("r2")],
    });
    const board = await getWeatherBoard(db, "pr1");
    expect(board.ok && board.data.readings[0]?.recordedBy).toBe("Frank");
    expect(
      (
        await setWeatherThreshold(db, "o1", "pr1", {
          hazard: "Wind",
          level: "Restrict",
          value: 32,
          sourceNote: "Plan",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await setWeatherThreshold(db, "o1", "pr1", {
          hazard: "Lightning",
          level: "Evacuate",
          value: 8,
          sourceNote: "Plan",
        })
      ).ok,
    ).toBe(true);
    expect(
      stepsOf(calls.filter((x) => x.target === "from:weather_thresholds")[4], "insert")[0]?.[0],
    ).toMatchObject({ unit: "mi", comparison: "At or Below" });
    expect((await addWeatherAlertRole(db, "o1", "pr1", "Evacuate", "1000.01.01")).ok).toBe(true);
    expect((await removeWeatherAlertRole(db, "ar2")).ok).toBe(true);
    expect((await recordWeatherReading(db, "pr1", "Heat", 104)).ok).toBe(true);
    const thresholds = [
      { hazard: "Wind" as const, level: "Monitor" as const, value: 20 },
      { hazard: "Wind" as const, level: "Restrict" as const, value: 30 },
      { hazard: "Lightning" as const, level: "Evacuate" as const, value: 8 },
    ];
    expect(weatherLevel(thresholds, "Wind", 33)).toBe("Restrict");
    expect(weatherLevel(thresholds, "Wind", 10)).toBeNull();
    expect(weatherLevel(thresholds, "Lightning", 5)).toBe("Evacuate");
    expect(weatherLevel(thresholds, "Lightning", 12)).toBeNull();
  });

  it("handles door check-in and the lost and found log", async () => {
    const { db } = moduleClient({
      "rpc:door_guest_list": [
        okResponse([
          {
            guest_list_entry_id: "g1",
            guest_name: "Jordan",
            plus_ones: 2,
            entry_state: "Checked In",
            note: null,
            checked_in_at: "x",
            plus_ones_admitted: 2,
            door: "A",
          },
          {
            guest_list_entry_id: "g2",
            guest_name: "Sam",
            plus_ones: 0,
            entry_state: "Approved",
            note: "VIP",
            checked_in_at: null,
            plus_ones_admitted: null,
            door: null,
          },
        ]),
      ],
      "rpc:check_in_guest": [okResponse("ci1")],
      "from:lost_found_items": [
        okResponse([
          {
            id: "i1",
            project_id: "pr1",
            item_number: "LF-0001",
            category: "Wallet",
            description: "Brown",
            found_at: "2026-10-01T00:00:00Z",
            found_location: "Bar 2",
            storage_location: null,
            item_state: "Claimed",
            logger: who("Frank"),
            lost_found_claims: [
              {
                id: "cl1",
                claimant_name: "Riley",
                claimant_contact: "555",
                proof_description: "Card",
                decided_at: null,
                returned: null,
                decision_note: null,
                created_at: "2026-10-02T00:00:00Z",
              },
              {
                id: "cl0",
                claimant_name: "Old",
                claimant_contact: "555",
                proof_description: "No",
                decided_at: "x",
                returned: false,
                decision_note: "Wrong",
                created_at: "2026-10-01T00:00:00Z",
              },
            ],
          },
        ]),
        id("i1"),
      ],
      "rpc:log_lost_item": [okResponse("i2")],
      "rpc:claim_lost_item": [okResponse("cl2")],
      "rpc:settle_lost_item_claim": [okResponse("cl2")],
      "rpc:dispose_lost_item": [okResponse("l1")],
    });
    const guests = await listDoorGuests(db, "pr1", "j");
    expect(guests.ok && doorTotals(guests.data)).toEqual({ checkedIn: 1, expected: 2, people: 3 });
    expect((await checkInGuest(db, "g2", { plusOnesAdmitted: 0, door: "A" })).ok).toBe(true);
    const items = await listLostItems(db, "pr1");
    expect(items.ok && items.data[0]?.claims.map((c) => c.id)).toEqual(["cl1", "cl0"]);
    expect(items.ok && items.data[0]?.claims[1]?.returned).toBe(false);
    expect(
      (
        await logLostItem(db, {
          projectId: "pr1",
          category: "Keys",
          description: "Ring",
          foundLocation: "Gate",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await updateLostItem(db, "i1", {
          category: "Wallet",
          description: "Brown leather",
          storageLocation: "Locker 4",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await claimLostItem(db, "i1", {
          claimantName: "Riley",
          claimantContact: "555",
          proof: "Card",
        })
      ).ok,
    ).toBe(true);
    expect((await settleLostItemClaim(db, "cl2", true)).ok).toBe(true);
    expect((await disposeLostItem(db, "i1", "Unclaimed 90 days")).ok).toBe(true);
  });
});
