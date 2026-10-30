import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_LAYOUT_SETTINGS,
  DASHBOARD_TILES,
  formatLayout,
  LAYOUT_MAX_LENGTH,
  parseLayout,
  savedLayout,
} from "@/lib/dashboard/layout";

/**
 * Dashboard layouts (Section 11.6, A129): the spans a person gives the tiles of Home and the partner
 * console live in me.dashboard_layout.home and me.dashboard_layout.partner. Changing the stored value
 * changes the spans the dashboards render, a value that does not parse changes nothing, and the save
 * action writes only spans that fit the dashboard, as the person's own setting for every org.
 */

const state = vi.hoisted(() => ({
  viewer: null as unknown,
  writes: [] as { key: string; value: unknown; orgId?: string }[],
  clears: [] as { key: string }[],
  ok: true,
}));

vi.mock("@/lib/shell/context", () => ({ getViewer: async () => state.viewer }));
vi.mock("@xos/data/settings", () => ({
  setPersonalSetting: async (_db: unknown, input: { key: string; value: unknown }) => {
    state.writes.push(input);
    return state.ok ? { ok: true, data: { id: "s1" } } : { ok: false, error: { kind: "refused" } };
  },
  clearPersonalSetting: async (_db: unknown, input: { key: string }) => {
    state.clears.push(input);
    return { ok: true, data: true };
  },
}));

const { resetDashboardLayoutAction, saveDashboardLayoutAction } =
  await import("@/lib/dashboard/layout-actions");

beforeEach(() => {
  state.viewer = { db: {}, person: { id: "p1" } };
  state.writes = [];
  state.clears = [];
  state.ok = true;
});

describe("reading a saved layout", () => {
  it("renders Home at the spans stored in me.dashboard_layout.home", () => {
    const settings = new Map<string, unknown>([
      ["me.dashboard_layout.home", "checklist:6,plan:6,alerts:12"],
      ["me.dashboard_layout.partner", "seats:6"],
    ]);
    expect(savedLayout("home", (key) => settings.get(key))).toEqual({
      checklist: 6,
      plan: 6,
      alerts: 12,
    });
    expect(savedLayout("partner", (key) => settings.get(key))).toEqual({ seats: 6 });
    settings.set("me.dashboard_layout.home", "plan:8");
    expect(savedLayout("home", (key) => settings.get(key))).toEqual({ plan: 8 });
  });

  it("keeps the default spans when nothing is saved or a pair does not parse", () => {
    expect(savedLayout("home", () => undefined)).toEqual({});
    expect(savedLayout("home", () => null)).toEqual({});
    expect(parseLayout(12)).toEqual({});
    expect(parseLayout("plan:0, alerts:13,Bad:4,readiness:x, activity:5 ,,checklist")).toEqual({
      activity: 5,
    });
  });
});

describe("writing a layout", () => {
  it("names only tiles the dashboard has, with spans of 1 to 12", () => {
    expect(formatLayout("home", { checklist: 8, plan: 4 })).toBe("checklist:8,plan:4");
    expect(formatLayout("home", { seats: 6 })).toBeNull();
    expect(formatLayout("partner", { seats: 6 })).toBe("seats:6");
    expect(formatLayout("home", { plan: 0 })).toBeNull();
    expect(formatLayout("home", { plan: 4.5 })).toBeNull();
    const every = Object.fromEntries(DASHBOARD_TILES.home.map((id) => [id, 12]));
    const value = formatLayout("home", every) ?? "";
    expect(value.length).toBeLessThanOrEqual(LAYOUT_MAX_LENGTH);
    expect(parseLayout(value)).toEqual(every);
  });

  it("saves the spans as the person's own me.dashboard_layout.home for every org", async () => {
    expect(await saveDashboardLayoutAction("home", { readiness: 8, alerts: 4 })).toEqual({
      ok: true,
    });
    expect(state.writes).toEqual([
      { key: DASHBOARD_LAYOUT_SETTINGS.home, value: "readiness:8,alerts:4" },
    ]);
    expect(await saveDashboardLayoutAction("partner", { clients: 6 })).toEqual({ ok: true });
    expect(state.writes.at(-1)).toEqual({ key: "me.dashboard_layout.partner", value: "clients:6" });
  });

  it("refuses an unknown dashboard, a tile it does not have and a signed-out caller", async () => {
    expect(await saveDashboardLayoutAction("reports", { plan: 4 })).toEqual({ ok: false });
    expect(await saveDashboardLayoutAction("home", { "<script>": 4 })).toEqual({ ok: false });
    state.viewer = null;
    expect(await saveDashboardLayoutAction("home", { plan: 4 })).toEqual({ ok: false });
    expect(state.writes).toEqual([]);
    state.viewer = { db: {}, person: { id: "p1" } };
    state.ok = false;
    expect(await saveDashboardLayoutAction("home", { plan: 4 })).toEqual({ ok: false });
  });

  it("resets a dashboard by clearing the person's value", async () => {
    expect(await resetDashboardLayoutAction("partner")).toEqual({ ok: true });
    expect(state.clears).toEqual([{ key: "me.dashboard_layout.partner" }]);
    expect(await resetDashboardLayoutAction("elsewhere")).toEqual({ ok: false });
  });
});
