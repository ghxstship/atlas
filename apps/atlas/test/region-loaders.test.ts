/**
 * Loaders that read a page's regions together give each region its own result (ADR 0118): one read
 * that fails takes down only the regions built on it, is reported once on the server, and the rest
 * of the page still gets its data. Home's tiles (lib/home/data.ts), the record page's panels
 * (components/work/record-detail.tsx) and the shell's peek (lib/shell/peek-actions.ts) are read
 * with @xos/data replaced by the answers each read gives.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "@/lib/shell/context";

const data = vi.hoisted(() => ({
  projects: vi.fn(),
  phases: vi.fn(),
  criteria: vi.fn(),
  statuses: vi.fn(),
  blocked: vi.fn(),
  overdue: vi.fn(),
  due: vi.fn(),
  activity: vi.fn(),
  record: vi.fn(),
  history: vi.fn(),
  conversation: vi.fn(),
  relations: vi.fn(),
}));
const report = vi.hoisted(() => vi.fn());

vi.mock("@xos/data/projects", () => ({
  listProjects: data.projects,
  listPhases: data.phases,
  listGateCriteria: data.criteria,
  listCriterionStatus: data.statuses,
}));
vi.mock("@xos/data/home", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listBlockedRecords: data.blocked,
  listMyOverdueRecords: data.overdue,
  listMyRecordsBetween: data.due,
}));
vi.mock("@xos/data/activity", () => ({
  listActivity: data.activity,
  labelActivity: async (_db: unknown, entries: unknown[]) => entries,
}));
const work = vi.hoisted(() => ({
  getRecordExtension: vi.fn(),
  getWatch: vi.fn(),
  listAssignments: vi.fn(),
  listChecklist: vi.fn(),
  listCurrencyOptions: vi.fn(),
  listRecords: vi.fn(),
  listRecurrences: vi.fn(),
  listReplans: vi.fn(),
  listScopeNodeRefs: vi.fn(),
}));
vi.mock("@xos/data/work", () => ({
  getRecordByKey: data.record,
  listStateHistory: data.history,
  nextStates: () => [],
  replanShift: () => ({ moved: false, endShiftMs: 0 }),
  ...work,
}));
vi.mock("@xos/data/field-history", () => ({ getFieldHistory: async () => ok([]) }));
vi.mock("@xos/data/schedule", () => ({ getActual: async () => ok(null) }));
vi.mock("@xos/data/work-orders", () => ({ getPunchItemForRecord: async () => ok(null) }));
vi.mock("@/components/work/load", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadRecordMeta: async () => ({ people: [], phases: [], kinds: [], states: [], rules: [] }),
  capabilitySet: async () => new Set(["work.record.write"]),
}));
vi.mock("@/components/work/kind-fields", () => ({ kindFields: async () => [] }));
vi.mock("@/lib/shell/org-settings", () => ({
  getShellSettings: async () => ({
    preferences: { timeZoneDisplay: "record" },
    viewerTimeZone: null,
  }),
}));
vi.mock("@/components/work/record-sections", () => ({
  loadConversation: data.conversation,
  loadRelations: data.relations,
}));
vi.mock("@/lib/shell/time-zone", () => ({ getOrgTimeZone: async () => "UTC" }));
vi.mock("@/lib/shell/recents", () => ({ rememberView: async () => undefined }));
vi.mock("@/lib/observability", () => ({
  observability: { errors: { report }, logger: { error: vi.fn() } },
}));

function ok<T>(value: T) {
  return { ok: true as const, data: value };
}

const ctx = {
  org: { id: "o1", slug: "acme" },
  viewer: { db: {}, person: { id: "p1" } },
  capabilities: new Set(["activity.feed.read"]),
} as unknown as OrgContext;
vi.mock("@/lib/shell/context", () => ({ getOrgContext: async () => ctx }));

const { loadHomeTiles } = await import("@/lib/home/data");
const { loadShellPeekAction } = await import("@/lib/shell/peek-actions");
const { loadRecordDetail } = await import("@/components/work/record-detail");
const fail = { ok: false as const, error: { kind: "unexpected", message: "connection reset" } };
const project = (id: string, state: string) => ({
  id,
  key: id.toUpperCase(),
  name: `Project ${id}`,
  projectState: state,
  phaseCode: "G1",
});

beforeEach(() => {
  for (const fn of Object.values(data)) fn.mockReset();
  report.mockReset();
  data.projects.mockResolvedValue(
    ok([project("p1", "Active"), project("p2", "Blocked"), project("p3", "Complete")]),
  );
  data.phases.mockResolvedValue(ok([{ code: "G1", gate: 1, label: "Concept", ordinal: 1 }]));
  data.criteria.mockResolvedValue(ok([]));
  data.statuses.mockResolvedValue(ok([]));
  data.blocked.mockResolvedValue(ok([]));
  data.overdue.mockResolvedValue(ok([]));
  data.due.mockResolvedValue(ok([{ id: "r1" }, { id: "r2" }]));
  data.activity.mockResolvedValue(ok({ entries: [{ id: "a1", at: "2026-10-30T12:00:00Z" }] }));
});

describe("Home's tiles", () => {
  it("read every tile when every read succeeds", async () => {
    const tiles = await loadHomeTiles(ctx);
    expect(tiles.projectCount).toBe(3);
    expect(tiles.active).toEqual(ok(2));
    expect(tiles.blocked).toEqual(ok(1));
    expect(tiles.dueToday).toEqual(ok(2));
    expect(tiles.openBlockers).toEqual(ok(0));
    expect(tiles.readiness.ok).toBe(true);
    expect(tiles.alerts.ok).toBe(true);
    expect(tiles.activity).toEqual(ok([{ id: "a1", at: "2026-10-30T12:00:00Z" }]));
    expect(report).not.toHaveBeenCalled();
  });

  it("fail only the activity tile when the activity read fails", async () => {
    data.activity.mockResolvedValue(fail);
    const tiles = await loadHomeTiles(ctx);
    expect(tiles.activity).toEqual({ ok: false });
    expect(tiles.active).toEqual(ok(2));
    expect(tiles.dueToday).toEqual(ok(2));
    expect(tiles.readiness.ok).toBe(true);
    expect(tiles.alerts.ok).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[1]).toEqual({
      tags: { source: "region", region: "home.activity" },
    });
  });

  it("fail readiness, open blockers and alerts together when gate readiness cannot be read", async () => {
    data.statuses.mockResolvedValue(fail);
    const tiles = await loadHomeTiles(ctx);
    expect(tiles.readiness).toEqual({ ok: false });
    expect(tiles.openBlockers).toEqual({ ok: false });
    expect(tiles.alerts).toEqual({ ok: false });
    expect(tiles.active).toEqual(ok(2));
    expect(tiles.activity.ok).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("fail only today's count when the viewer's records for today cannot be read", async () => {
    data.due.mockResolvedValue(fail);
    const tiles = await loadHomeTiles(ctx);
    expect(tiles.dueToday).toEqual({ ok: false });
    expect(tiles.active).toEqual(ok(2));
    expect(tiles.alerts.ok).toBe(true);
  });
});

const peekRecord = () =>
  ok({
    id: "r1",
    key: "NWS-1",
    kind: "Task",
    state: "Active",
    title: "Rig the truss",
    projectKey: "NWS",
    projectName: "News",
    ownerName: null,
    phaseCode: null,
    startsAt: null,
    endsAt: null,
    dueAt: null,
    timeZone: null,
    projectTimeZone: "UTC",
    blockerText: null,
    deletedAt: null,
  });

describe("the record page's panels", () => {
  beforeEach(() => {
    data.record.mockResolvedValue(peekRecord());
    data.history.mockResolvedValue(ok([]));
    data.conversation.mockResolvedValue({ threads: [], attachments: [], names: {} });
    data.relations.mockResolvedValue({ relations: { parent: null }, dependencies: [] });
    for (const fn of Object.values(work)) fn.mockResolvedValue(ok([]));
    work.getRecordExtension.mockResolvedValue(ok({}));
    work.getWatch.mockResolvedValue(ok(null));
    work.listChecklist.mockResolvedValue(ok([{ id: "c1", label: "Load in", done: false }]));
    work.listRecurrences.mockResolvedValue(ok(new Map()));
  });

  it("fail only the checklist when the checklist read fails", async () => {
    work.listChecklist.mockResolvedValue(fail);
    const detail = await loadRecordDetail(ctx, "NWS-1");
    expect(detail?.checklist).toEqual({ ok: false });
    expect(detail?.assignments).toEqual(ok([]));
    expect(detail?.history).toEqual(ok([]));
    expect(detail?.conversation.ok).toBe(true);
    expect(detail?.related.ok).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[1]).toEqual({
      tags: { source: "region", region: "record.checklist" },
    });
  });

  it("fail only the related records when they cannot be read", async () => {
    data.relations.mockRejectedValue(new Error("Cannot load dependencies"));
    const detail = await loadRecordDetail(ctx, "NWS-1");
    expect(detail?.related).toEqual({ ok: false });
    expect(detail?.checklist.ok).toBe(true);
    expect(detail?.record.key).toBe("NWS-1");
  });
});

describe("the shell's peek", () => {
  beforeEach(() => {
    data.record.mockResolvedValue(peekRecord());
    data.history.mockResolvedValue(ok([]));
    data.conversation.mockResolvedValue({ threads: [], attachments: [], names: {} });
    data.relations.mockResolvedValue({ relations: { parent: null }, dependencies: [] });
  });

  it("still opens when the comments cannot be read, with only that section failed", async () => {
    data.conversation.mockRejectedValue(new Error("Cannot load comments"));
    const peek = await loadShellPeekAction("acme", "NWS-1");
    expect(peek.ok).toBe(true);
    if (!peek.ok) return;
    expect(peek.record.conversation).toEqual({ ok: false });
    expect(peek.record.relations).toEqual(ok({ parent: null }));
    expect(report).toHaveBeenCalledTimes(1);
  });
});
