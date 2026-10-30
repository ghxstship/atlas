import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Personal settings, Calendar Feeds (B7, ADR 0146) against a recording client: a project feed is added with a name,
 * cues, a team audience and a show department in one RPC call; Edit replaces the configuration; a member feed takes
 * no audience; the four 4.0 sources alone are sent as the default; and the 2961 refusals come back as their rule.
 */

const ORG = "0190a000-0000-7000-8000-000000000001";
const PROJECT = "0190a000-0000-7000-8000-000000000002";
const TEAM = "0190a000-0000-7000-8000-000000000003";
const FEED = "0190a000-0000-7000-8000-000000000004";
const token = `xcal_${"b".repeat(64)}`;
const state = vi.hoisted(() => ({
  rpc: [] as { name: string; args: Record<string, unknown> }[],
  answer: null as { data: unknown; error: unknown } | null,
}));

const db = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    state.rpc.push({ name, args });
    if (state.answer) return state.answer;
    if (name === "create_calendar_feed") {
      return { data: [{ calendar_feed_id: FEED, feed_token: token }], error: null };
    }
    return { data: null, error: null };
  },
};

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
}));
vi.mock("@/lib/env", () => ({ env: () => ({ ATLAS_SITE_URL: "https://atlas.example.test" }) }));
vi.mock("@/lib/shell/context", () => ({
  getOrgContext: async () => ({ org: { id: ORG, slug: "acme" }, viewer: { db } }),
}));

const { addCalendarFeedAction, configureCalendarFeedAction } =
  await import("@/app/[org]/me/calendar-feed-actions");

const form = (entries: [string, string][]) => {
  const f = new FormData();
  f.append("org", "acme");
  for (const [k, v] of entries) f.append(k, v);
  return f;
};

beforeEach(() => {
  state.rpc = [];
  state.answer = null;
});

describe("named and filtered feeds", () => {
  it("adds a project feed with its whole configuration in one call", async () => {
    const result = await addCalendarFeedAction(
      {},
      form([
        ["scope", PROJECT],
        ["name", "Lighting crew"],
        ["sources", "Shifts"],
        ["sources", "Cues"],
        ["audienceKind", "team"],
        ["teamId", TEAM],
        ["cueCallKind", "Lighting"],
      ]),
    );
    expect(result).toEqual({ ok: true, link: `https://atlas.example.test/ical/${token}.ics` });
    expect(state.rpc).toEqual([
      {
        name: "create_calendar_feed",
        args: {
          p_org_id: ORG,
          p_project_id: PROJECT,
          p_name: "Lighting crew",
          p_sources: ["Shifts", "Cues"],
          p_person_ids: null,
          p_team_id: TEAM,
          p_department_code: null,
          p_cue_call_kind: "Lighting",
        },
      },
    ]);
  });

  it("gives a member feed no audience and sends the four 4.0 sources as the default", async () => {
    await addCalendarFeedAction(
      {},
      form([
        ["scope", "mine"],
        ["sources", "Shifts"],
        ["sources", "Meetings"],
        ["sources", "Milestones"],
        ["sources", "Deadlines"],
        ["audienceKind", "team"],
        ["teamId", TEAM],
      ]),
    );
    expect(state.rpc[0]?.args).not.toHaveProperty("p_project_id");
    expect(state.rpc[0]?.args).toMatchObject({
      p_name: null,
      p_sources: null,
      p_team_id: null,
      p_cue_call_kind: null,
    });
  });

  it("edits a feed's people audience and maps the refusals to their copy", async () => {
    const people = ["0190a000-0000-7000-8000-0000000000b1", "0190a000-0000-7000-8000-0000000000b2"];
    expect(
      await configureCalendarFeedAction(
        {},
        form([
          ["id", FEED],
          ["projectFeed", "true"],
          ["name", "Show calls"],
          ["sources", "Cues"],
          ["audienceKind", "people"],
          ...people.map((p) => ["personIds", p] as [string, string]),
          ["cueCallKind", "any"],
        ]),
      ),
    ).toEqual({ ok: true });
    expect(state.rpc[0]).toEqual({
      name: "configure_calendar_feed",
      args: {
        p_calendar_feed_id: FEED,
        p_name: "Show calls",
        p_sources: ["Cues"],
        p_person_ids: people,
        p_team_id: null,
        p_department_code: null,
        p_cue_call_kind: null,
      },
    });
    for (const rule of [
      "calendar_feed_name",
      "calendar_feed_filter_scope",
      "calendar_feed_audience",
      "calendar_feed_people_limit",
      "calendar_feed_sources",
    ]) {
      state.answer = {
        data: null,
        error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
      };
      expect(await configureCalendarFeedAction({}, form([["id", FEED]]))).toEqual({ error: rule });
    }
    state.answer = null;
    expect(
      await configureCalendarFeedAction(
        {},
        form([
          ["id", FEED],
          ["projectFeed", "true"],
          ["audienceKind", "department"],
          ["departmentCode", "51"],
        ]),
      ),
    ).toEqual({ error: "invalid" });
  });
});
