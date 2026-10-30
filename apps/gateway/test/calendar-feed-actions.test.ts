import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Gateway Settings, Calendar Feeds (B7, ADR 0146): a personal feed is added and edited with a name and content,
 * cues included, against a recording client. The four 4.0 sources alone are sent as the default (null), none
 * checked as an empty list, and the 2961 refusals come back as their rule for the form's copy.
 */

const token = `xcal_${"a".repeat(64)}`;
const state = vi.hoisted(() => ({
  rpc: [] as { name: string; args: Record<string, unknown> }[],
  answer: null as { data: unknown; error: unknown } | null,
}));

const db = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    state.rpc.push({ name, args });
    if (state.answer) return state.answer;
    if (name === "create_person_calendar_feed") {
      return { data: [{ calendar_feed_id: "f1", feed_token: token }], error: null };
    }
    return { data: null, error: null };
  },
};

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/env", () => ({ env: () => ({ GATEWAY_SITE_URL: "https://gateway.example.test" }) }));
vi.mock("@/lib/shell/context", () => ({ getGatewayContext: async () => ({ db }) }));

const { addPersonFeedAction, configurePersonFeedAction } =
  await import("@/lib/actions/calendar-feeds");

const form = (entries: [string, string][]) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};

beforeEach(() => {
  state.rpc = [];
  state.answer = null;
});

describe("personal feeds with a name and content", () => {
  it("adds a named feed with cues and shows its link once", async () => {
    const result = await addPersonFeedAction(
      {},
      form([
        ["name", "My gigs"],
        ["sources", "Shifts"],
        ["sources", "Cues"],
      ]),
    );
    expect(result).toEqual({ ok: true, link: `https://gateway.example.test/ical/${token}.ics` });
    expect(state.rpc).toEqual([
      {
        name: "create_person_calendar_feed",
        args: { p_name: "My gigs", p_sources: ["Shifts", "Cues"] },
      },
    ]);
  });

  it("saves the four 4.0 sources as the default set", async () => {
    await addPersonFeedAction(
      {},
      form([
        ["name", ""],
        ["sources", "Shifts"],
        ["sources", "Meetings"],
        ["sources", "Milestones"],
        ["sources", "Deadlines"],
      ]),
    );
    expect(state.rpc[0]?.args).toEqual({ p_name: null, p_sources: null });
  });

  it("edits a feed and maps the refusals to their copy", async () => {
    expect(
      await configurePersonFeedAction(
        {},
        form([
          ["id", "0192a000-0000-7000-8000-00000000000a"],
          ["name", "Tour"],
          ["sources", "Cues"],
        ]),
      ),
    ).toEqual({ ok: true });
    expect(state.rpc[0]).toEqual({
      name: "configure_person_calendar_feed",
      args: {
        p_calendar_feed_id: "0192a000-0000-7000-8000-00000000000a",
        p_name: "Tour",
        p_sources: ["Cues"],
      },
    });
    state.answer = {
      data: null,
      error: {
        code: "XR001",
        message: "calendar_feed_sources: Choose.",
        hint: "calendar_feed_sources",
      },
    };
    expect(
      await configurePersonFeedAction({}, form([["id", "0192a000-0000-7000-8000-00000000000a"]])),
    ).toEqual({
      error: "calendar_feed_sources",
    });
    expect(state.rpc.at(-1)?.args).toMatchObject({ p_sources: [] });
    state.answer = {
      data: null,
      error: { code: "XR001", message: "calendar_feed_name: Taken.", hint: "calendar_feed_name" },
    };
    expect(
      await configurePersonFeedAction(
        {},
        form([
          ["id", "0192a000-0000-7000-8000-00000000000a"],
          ["name", "Tour"],
          ["sources", "Cues"],
        ]),
      ),
    ).toEqual({
      error: "calendar_feed_name",
    });
    expect(await configurePersonFeedAction({}, form([["id", "not-a-feed"]]))).toEqual({
      error: "denied",
    });
  });
});
