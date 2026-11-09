// @vitest-environment jsdom
/**
 * A145 follow-up (RRR-243, ADR 0119 amendment): show mode hears a cue call on its running order's private channel
 * show:<run id>, which the database sends to (migration 6900), as well as in the cue's Postgres change. LiveCues joins
 * that channel once per running order, hands each well-formed call to onCalled, ignores anything else, and leaves the
 * channel when it unmounts. The live hub and Realtime are stand-ins.
 */
import type { LiveRoomHandlers } from "@xos/data/live";
import type * as XosUi from "@xos/ui";
import { act, cleanup, render } from "@testing-library/react";
import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hub = vi.hoisted(() => ({
  joins: [] as { topic: string; events: readonly string[]; handlers: LiveRoomHandlers }[],
  leave: vi.fn(),
  rows: null as ((changes: readonly unknown[]) => void) | null,
}));

vi.mock("@/components/live/live-source", () => ({
  loadHub: async () => ({
    room: (topic: string, options: { events: readonly string[] }, handlers: LiveRoomHandlers) => {
      hub.joins.push({ topic, events: options.events, handlers });
      return { send: async () => false, track: async () => undefined, leave: hub.leave };
    },
  }),
}));
vi.mock("@/components/live/live-refresh", () => ({ useLiveRefresh: () => undefined }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@xos/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof XosUi>()),
  useLive: (_topics: unknown, onChange: (changes: readonly unknown[]) => void) => {
    hub.rows = onChange;
  },
}));

const { LiveCues } = await import("@/components/show/live-cues");

beforeEach(() => {
  hub.joins = [];
  hub.leave.mockClear();
  hub.rows = null;
});
afterEach(cleanup);

/** Lets the hub's promise settle, so the channel joins. */
const joined = () => act(async () => {});

/** The handlers of the nth channel joined. */
function room(n = 0): LiveRoomHandlers {
  const join = hub.joins[n];
  if (!join) throw new Error(`no channel ${n} was joined`);
  return join.handlers;
}

describe("LiveCues", () => {
  it("joins the running order's show channel for its called messages", async () => {
    render(h(LiveCues, { runId: "run-1", onCalled: vi.fn() }));
    await joined();
    expect(hub.joins.map((j) => [j.topic, j.events])).toEqual([["show:run-1", ["called"]]]);
  });

  it("hands each call on the channel to onCalled, and ignores a message without a cue or a time", async () => {
    const onCalled = vi.fn();
    render(h(LiveCues, { runId: "run-1", onCalled }));
    await joined();
    const handlers = room();
    act(() =>
      handlers.onBroadcast("called", {
        cue_id: "cue-1",
        called_at: "2027-03-13T19:30:00.12+00:00",
      }),
    );
    act(() => handlers.onBroadcast("called", { cue_id: "cue-2" }));
    act(() => handlers.onBroadcast("called", { called_at: "2027-03-13T19:31:00+00:00" }));
    expect(onCalled.mock.calls).toEqual([["cue-1", "2027-03-13T19:30:00.12+00:00"]]);
  });

  it("still hears a call in the cue's own row", async () => {
    const onCalled = vi.fn();
    render(h(LiveCues, { runId: "run-1", onCalled }));
    await joined();
    act(() =>
      hub.rows?.([
        {
          table: "cues",
          type: "UPDATE",
          id: "cue-3",
          row: { called_at: "2027-03-13T19:32:00+00:00" },
        },
      ]),
    );
    expect(onCalled).toHaveBeenCalledWith("cue-3", "2027-03-13T19:32:00+00:00");
  });

  it("hears with the latest onCalled without joining again, and leaves when it unmounts", async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const view = render(h(LiveCues, { runId: "run-1", onCalled: first }));
    await joined();
    view.rerender(h(LiveCues, { runId: "run-1", onCalled: latest }));
    await joined();
    expect(hub.joins).toHaveLength(1);
    act(() => room().onBroadcast("called", { cue_id: "cue-1", called_at: "2027-03-13T19:30:00Z" }));
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith("cue-1", "2027-03-13T19:30:00Z");
    view.unmount();
    expect(hub.leave).toHaveBeenCalledTimes(1);
  });

  it("joins the new running order's channel when the run changes", async () => {
    const view = render(h(LiveCues, { runId: "run-1", onCalled: vi.fn() }));
    await joined();
    view.rerender(h(LiveCues, { runId: "run-2", onCalled: vi.fn() }));
    await joined();
    expect(hub.leave).toHaveBeenCalledTimes(1);
    expect(hub.joins.map((j) => j.topic)).toEqual(["show:run-1", "show:run-2"]);
  });
});
