import { describe, expect, it } from "vitest";
import {
  answerAvailabilityPoll,
  availabilityPollResults,
  listAvailabilityPolls,
  listPollablePeople,
  myAvailabilityRequests,
  pollIsOpen,
  sendAvailabilityPoll,
} from "../src/crew.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/**
 * Availability polls (P8, migration 2853): sending, answering, the planners' results, the recipient's requests,
 * the project's polls and the people a poll can ask. The database decides every rule; these read its answers.
 */

const NOW = new Date("2027-06-02T12:00:00Z");

describe("availability polls", () => {
  it("sends a poll with only the optional fields given", async () => {
    const { db, calls } = fakeClient({
      "rpc:send_availability_poll": [
        okResponse("poll-1"),
        okResponse("poll-2"),
        errorResponse(
          "XR001",
          "availability_poll_recipient: Quinn is not engaged.",
          "availability_poll_recipient",
        ),
      ],
    });
    const input = {
      projectId: "p1",
      title: " Load-in week ",
      days: ["2027-06-10", "2027-06-11"],
      personIds: ["a", "b"],
    };
    expect(await sendAvailabilityPoll(db, input)).toEqual({ ok: true, data: "poll-1" });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [
        {
          p_project_id: "p1",
          p_title: "Load-in week",
          p_days: ["2027-06-10", "2027-06-11"],
          p_person_ids: ["a", "b"],
        },
      ],
    ]);
    await sendAvailabilityPoll(db, {
      ...input,
      message: " Which days? ",
      closesAt: "2027-06-05T03:59:00Z",
    });
    expect(calls[1]?.steps[0]?.[1][0]).toMatchObject({
      p_message: "Which days?",
      p_closes_at: "2027-06-05T03:59:00Z",
    });
    const refused = await sendAvailabilityPoll(db, input);
    expect(refused.ok === false && refused.error).toMatchObject({
      rule: "availability_poll_recipient",
    });
  });

  it("answers day by day and reports the days the notice lock kept", async () => {
    const { db, calls } = fakeClient({
      "rpc:answer_availability_poll": [
        okResponse([
          { day: "2027-06-03", availability_kind: "Available", written: false },
          { day: "2027-06-10", availability_kind: "Tentative", written: true },
        ]),
        errorResponse(
          "XR001",
          "availability_poll_closed: This poll has closed.",
          "availability_poll_closed",
        ),
      ],
    });
    const answers = [
      { day: "2027-06-03", kind: "Available" as const },
      { day: "2027-06-10", kind: "Tentative" as const },
    ];
    expect(await answerAvailabilityPoll(db, { pollId: "poll-1", answers })).toEqual({
      ok: true,
      data: [
        { day: "2027-06-03", kind: "Available", written: false },
        { day: "2027-06-10", kind: "Tentative", written: true },
      ],
    });
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_poll_id: "poll-1", p_answers: answers }]]);
    const closed = await answerAvailabilityPoll(db, { pollId: "poll-1", answers });
    expect(closed.ok === false && closed.error).toMatchObject({ rule: "availability_poll_closed" });
  });

  it("reads the planners' person-by-day results", async () => {
    const { db } = fakeClient({
      "rpc:availability_poll_results": [
        okResponse([
          {
            person_id: "a",
            full_name: "Frank Adeyemi",
            day: "2027-06-10",
            availability: "Available",
            answered_by_poll: true,
            responded_at: "2027-06-02T10:00:00Z",
          },
          {
            person_id: "b",
            full_name: null,
            day: "2027-06-10",
            availability: "Unstated",
            answered_by_poll: false,
            responded_at: null,
          },
        ]),
        errorResponse("42501", "crew.shift.write is required"),
      ],
    });
    const results = await availabilityPollResults(db, "poll-1");
    expect(results.ok && results.data).toEqual([
      {
        personId: "a",
        name: "Frank Adeyemi",
        day: "2027-06-10",
        availability: "Available",
        answeredByPoll: true,
        respondedAt: "2027-06-02T10:00:00Z",
      },
      {
        personId: "b",
        name: null,
        day: "2027-06-10",
        availability: "Unstated",
        answeredByPoll: false,
        respondedAt: null,
      },
    ]);
    expect((await availabilityPollResults(db, "poll-1")).ok).toBe(false);
  });

  it("groups the recipient's requests by poll, days in order", async () => {
    const row = {
      poll_id: "poll-1",
      org_id: "o1",
      org_name: "Tidewater",
      project_name: "Weekend",
      title: "Load-in week",
      message: null,
      closes_at: null,
      responded_at: null,
    };
    const { db } = fakeClient({
      "rpc:my_availability_requests": [
        okResponse([
          { ...row, day: "2027-06-10", answer: "Available", locked: false },
          { ...row, day: "2027-06-11", answer: null, locked: true },
          {
            ...row,
            poll_id: "poll-2",
            title: "Strike",
            day: "2027-06-20",
            answer: null,
            locked: false,
          },
        ]),
        errorResponse("XX000", "boom"),
      ],
    });
    const requests = await myAvailabilityRequests(db);
    expect(requests.ok && requests.data.map((r) => [r.pollId, r.days.length])).toEqual([
      ["poll-1", 2],
      ["poll-2", 1],
    ]);
    expect(requests.ok && requests.data[0]?.days[1]).toEqual({
      day: "2027-06-11",
      answer: null,
      locked: true,
    });
    expect((await myAvailabilityRequests(db)).ok).toBe(false);
  });

  it("lists a project's live polls with their live days and recipients, and whether they are open", async () => {
    const { db, calls } = fakeClient({
      "from:availability_polls": [
        okResponse([
          {
            id: "poll-1",
            project_id: "p1",
            title: "Load-in week",
            message: "Which days?",
            closes_at: "2027-06-05T03:59:00Z",
            created_at: "2027-06-01T12:00:00Z",
            days: [
              { day: "2027-06-11", deleted_at: null },
              { day: "2027-06-10", deleted_at: null },
              { day: "2027-06-12", deleted_at: "2027-06-01T13:00:00Z" },
            ],
            recipients: [
              { id: "r1", deleted_at: null },
              { id: "r2", deleted_at: "2027-06-01T13:00:00Z" },
            ],
          },
        ]),
        errorResponse("XX000", "boom"),
      ],
    });
    expect(await listAvailabilityPolls(db, [])).toEqual({ ok: true, data: [] });
    const polls = await listAvailabilityPolls(db, ["p1"]);
    expect(polls.ok && polls.data[0]).toMatchObject({
      days: ["2027-06-10", "2027-06-11"],
      recipientCount: 1,
    });
    expect(calls[0]?.steps).toContainEqual(["in", ["project_id", ["p1"]]]);
    expect((await listAvailabilityPolls(db, ["p1"])).ok).toBe(false);
    expect(pollIsOpen({ closesAt: null }, NOW)).toBe(true);
    expect(pollIsOpen({ closesAt: "2027-06-05T03:59:00Z" }, NOW)).toBe(true);
    expect(pollIsOpen({ closesAt: "2027-06-01T00:00:00Z" }, NOW)).toBe(false);
  });

  it("offers active members and people engaged by the org, each once", async () => {
    const { db } = fakeClient({
      "from:memberships": [
        okResponse([{ person_id: "a", person: { full_name: "Zoe Member" } }]),
        okResponse([]),
        errorResponse("XX000", "boom"),
      ],
      "from:engagements": [
        okResponse([
          { person_id: "a", person: { full_name: "Zoe Member" } },
          { person_id: "b", person: { full_name: "Ivy Freelancer" } },
          { person_id: null, person: null },
        ]),
        errorResponse("XX000", "boom"),
        okResponse([]),
      ],
    });
    const people = await listPollablePeople(db, "o1", NOW);
    expect(people.ok && people.data).toEqual([
      { personId: "b", name: "Ivy Freelancer", engaged: true },
      { personId: "a", name: "Zoe Member", engaged: false },
    ]);
    expect((await listPollablePeople(db, "o1", NOW)).ok).toBe(false);
    expect((await listPollablePeople(db, "o1", NOW)).ok).toBe(false);
  });
});
