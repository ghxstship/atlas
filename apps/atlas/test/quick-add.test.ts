import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "@/lib/shell/context";
import { quickAddInput, recordWhen, shiftWhen } from "@/lib/quick-add/fields";
import { CANDIDATE_LIMIT, matchNamed, slug, type Named } from "@/lib/quick-add/match";

/**
 * Quick add (Section 11.7, ADR 0073): matching tokens, turning a line into record and shift fields,
 * and the server actions. Every list the actions read comes from the caller's own client, which row
 * level security limits to what they may see; here the data functions answer with exactly those
 * rows, and the tests check that nothing outside them is offered or written.
 */

const viewerDb = { name: "the caller's client" };
const state = vi.hoisted(() => ({
  ctx: null as unknown,
  people: [] as { membershipId: string; personId: string; name: string | null }[],
  members: [] as { membershipId: string; personId: string | null; name: string | null }[],
  projects: [] as { id: string; key: string; name: string; timeZone: string }[],
  nodes: [] as { id: string; projectId: string; code: string; name: string }[],
  created: [] as Record<string, unknown>[],
  shifts: [] as Record<string, unknown>[],
  reads: [] as unknown[],
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/shell/context", () => ({ getOrgContext: async () => state.ctx }));
vi.mock("@/lib/shell/translate", () => ({
  getTranslate: async () => (key: string) =>
    key.startsWith("work.kinds.") ? `${key.slice("work.kinds.".length)} (es)` : key,
}));
vi.mock("@/lib/canon/labels", () => ({
  getCanonLabels: async (_ctx: unknown, vocabulary: string) =>
    new Map(vocabulary === "category" ? [["5000.51.02", "Aparejo"]] : [["101", "Tramoyista"]]),
}));
vi.mock("@xos/data/work", () => ({
  listPeopleRefs: async (db: unknown) => {
    state.reads.push(db);
    return { ok: true, data: state.people };
  },
  listProjectRefs: async () => ({ ok: true, data: state.projects }),
  getProjectRef: async (_db: unknown, _org: string, key: string) => {
    const found = state.projects.find((p) => p.key === key);
    return found ? { ok: true, data: found } : { ok: false, error: { kind: "not-found" } };
  },
  listRecordKinds: async () => ({
    ok: true,
    data: [
      { kind: "Task", recordClass: "Work", titleGrammar: "", subtypes: [] },
      { kind: "Inspection", recordClass: "Control", titleGrammar: "", subtypes: [] },
      { kind: "Milestone", recordClass: "Time", titleGrammar: "", subtypes: [] },
    ],
  }),
  createRecord: async (_db: unknown, input: Record<string, unknown>) => {
    state.created.push(input);
    return { ok: true, data: { id: "r1", number: 7 } };
  },
  getRecord: async () => ({ ok: true, data: { key: "NWS-7" } }),
  formatRecordKey: (key: string, n: number) => `${key}-${n}`,
}));
vi.mock("@xos/data/canon", () => ({
  listCategories: async () => ({
    ok: true,
    data: [
      {
        urid: "5000.51.02",
        disciplineCode: "5000.51",
        name: "Rigging",
        xyz: "X",
        isExtension: true,
      },
      {
        urid: "5000.05.02",
        disciplineCode: "5000.05",
        name: "Rigging Hardware",
        xyz: null,
        isExtension: false,
      },
    ],
  }),
}));
vi.mock("@xos/data/crew", () => ({
  listCrewMembers: async (db: unknown) => {
    state.reads.push(db);
    return { ok: true, data: state.members };
  },
  listCanonRoles: async () => ({
    ok: true,
    data: [{ code: "101", title: "Stagehand", discipline: "Stage", rank: "Crew" }],
  }),
  createShift: async (_db: unknown, input: Record<string, unknown>) => {
    state.shifts.push(input);
    return { ok: true, data: { id: "s1" } };
  },
}));
vi.mock("@xos/data/finance", () => ({
  listScopeNodes: async (db: unknown) => {
    state.reads.push(db);
    return { ok: true, data: state.nodes };
  },
}));

const { quickAddRecordAction, quickAddShiftAction, resolveQuickAddAction } =
  await import("@/lib/quick-add/actions");

const NWS = {
  id: "01920000-0000-7000-8000-000000000021",
  key: "NWS",
  name: "Northwind Summer Series",
  timeZone: "America/New_York",
};
const HBR = {
  id: "01920000-0000-7000-8000-000000000022",
  key: "HBR",
  name: "Harbor Lights",
  timeZone: "America/Los_Angeles",
};
const SECRET = {
  id: "01920000-0000-7000-8000-000000000023",
  key: "SEC",
  name: "Hidden",
  timeZone: "UTC",
};

function context(capabilities: string[]): OrgContext {
  return {
    org: { id: "org-1", slug: "northwind", membershipId: "01920000-0000-7000-8000-000000000011" },
    capabilities: new Set(capabilities),
    viewer: { db: viewerDb, person: { id: "01920000-0000-7000-8000-000000000001" } },
  } as unknown as OrgContext;
}

beforeEach(() => {
  state.ctx = context(["work.record.write", "crew.shift.write"]);
  state.people = [
    {
      membershipId: "01920000-0000-7000-8000-000000000011",
      personId: "01920000-0000-7000-8000-000000000001",
      name: "Sam Scheduler",
    },
    {
      membershipId: "01920000-0000-7000-8000-000000000012",
      personId: "01920000-0000-7000-8000-000000000002",
      name: "Dana Kim",
    },
    {
      membershipId: "01920000-0000-7000-8000-000000000013",
      personId: "01920000-0000-7000-8000-000000000003",
      name: "Dan Ortiz",
    },
  ];
  state.members = state.people.map((p) => ({ ...p }));
  state.projects = [NWS, HBR];
  state.nodes = [
    {
      id: "01920000-0000-7000-8000-000000000031",
      projectId: NWS.id,
      code: "NWS-E01",
      name: "Northwind Summer Series",
    },
    {
      id: "01920000-0000-7000-8000-000000000032",
      projectId: NWS.id,
      code: "NWS-S01",
      name: "Opening Night Concert",
    },
    {
      id: "01920000-0000-7000-8000-000000000033",
      projectId: HBR.id,
      code: "HBR-S01",
      name: "Opening Gala",
    },
    // A node of a project the caller cannot read never reaches the lists.
    {
      id: "01920000-0000-7000-8000-000000000034",
      projectId: SECRET.id,
      code: "SEC-S01",
      name: "Opening Secret",
    },
  ];
  state.created = [];
  state.shifts = [];
  state.reads = [];
});

describe("matchNamed", () => {
  const people: Named[] = [
    { id: "1", label: "Dana Kim", names: ["Dana Kim"] },
    { id: "2", label: "Dana Lee", names: ["Dana Lee"] },
    { id: "3", label: "José Núñez", names: ["José Núñez"], codes: ["me"] },
  ];

  it("folds case, accents and separators into slugs", () => {
    expect(slug("  Opening Night: Concert ")).toBe("opening-night-concert");
    expect(slug("José Núñez")).toBe("jose-nunez");
  });

  it("tries codes, whole names, words and starts in turn", () => {
    expect(matchNamed("me", people)).toMatchObject({ status: "resolved", id: "3" });
    expect(matchNamed("dana.kim", people)).toMatchObject({ status: "resolved", id: "1" });
    expect(matchNamed("danakim", people)).toMatchObject({ status: "resolved", id: "1" });
    expect(matchNamed("nunez", people)).toMatchObject({ status: "resolved", id: "3" });
    expect(matchNamed("jos", people)).toMatchObject({ status: "resolved", id: "3" });
  });

  it("offers a choice when a rule matches several, and nothing when none does", () => {
    expect(matchNamed("dana", people)).toEqual({
      status: "ambiguous",
      candidates: [
        { id: "1", label: "Dana Kim" },
        { id: "2", label: "Dana Lee" },
      ],
    });
    expect(matchNamed("zed", people)).toEqual({ status: "unresolved" });
    expect(matchNamed("--", people)).toEqual({ status: "unresolved" });
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `${i}`,
      label: `Stage ${i}`,
      names: [`Stage ${i}`],
    }));
    const offered = matchNamed("stage", many);
    expect(offered.status === "ambiguous" && offered.candidates.length).toBe(CANDIDATE_LIMIT);
  });
});

describe("quick add fields", () => {
  it("reads ids and the date from a finalized line", () => {
    expect(
      quickAddInput({
        title: "Truss Load Test",
        tokens: [
          {
            type: "person",
            value: "dana",
            icon: "User",
            id: "01920000-0000-7000-8000-000000000002",
          },
          { type: "date", value: "Friday 8am", icon: "Calendar", iso: "2026-10-09", time: "08:00" },
          { type: "kind", value: "inspection", icon: "Shapes", id: "Inspection" },
        ],
      }),
    ).toEqual({
      title: "Truss Load Test",
      personId: "01920000-0000-7000-8000-000000000002",
      tagId: null,
      kind: "Inspection",
      scopeNodeId: null,
      when: { iso: "2026-10-09", time: "08:00" },
    });
  });

  it("makes one date the due time, 17:00 without a time, and a range the start and end", () => {
    const zone = "America/New_York";
    expect(recordWhen(null, zone)).toEqual({ startsAt: null, endsAt: null, dueAt: null });
    expect(recordWhen({ iso: "2026-10-09", time: "08:00" }, zone).dueAt).toBe(
      "2026-10-09T12:00:00.000Z",
    );
    expect(recordWhen({ iso: "2026-10-09" }, zone).dueAt).toBe("2026-10-09T21:00:00.000Z");
    expect(recordWhen({ iso: "2026-10-09", endIso: "2026-10-11" }, zone)).toEqual({
      startsAt: "2026-10-09T12:00:00.000Z",
      endsAt: "2026-10-11T21:00:00.000Z",
      dueAt: null,
    });
  });

  it("gives a shift eight hours unless the line names its end", () => {
    const zone = "America/Los_Angeles";
    expect(shiftWhen(null, zone)).toBeNull();
    expect(shiftWhen({ iso: "2026-10-09" }, zone)).toEqual({
      startsAt: "2026-10-09T15:00:00.000Z",
      endsAt: "2026-10-09T23:00:00.000Z",
    });
    expect(shiftWhen({ iso: "2026-10-09", time: "22:00" }, zone)?.endsAt).toBe(
      "2026-10-10T13:00:00.000Z",
    );
    expect(
      shiftWhen({ iso: "2026-10-09", time: "22:00", endIso: "2026-10-10", endTime: "06:00" }, zone),
    ).toEqual({ startsAt: "2026-10-10T05:00:00.000Z", endsAt: "2026-10-10T13:00:00.000Z" });
  });
});

describe("resolveQuickAddAction", () => {
  const tokens = [
    { type: "person" as const, value: "dana" },
    { type: "person" as const, value: "zed" },
    { type: "scope" as const, value: "opening" },
    { type: "kind" as const, value: "inspection" },
    { type: "tag" as const, value: "rigging" },
  ];

  it("offers only the people and scopes the caller's client returns", async () => {
    const result = await resolveQuickAddAction("northwind", {
      target: "record",
      where: {},
      tokens,
    });
    expect(result.ok).toBe(true);
    const data = result.ok ? result.data : {};
    expect(data["person:dana"]).toMatchObject({
      status: "resolved",
      id: "01920000-0000-7000-8000-000000000002",
    });
    // Nobody named Zed is visible to the caller, so the token stays text.
    expect(data["person:zed"]).toEqual({ status: "unresolved" });
    // Opening Secret belongs to a project the caller cannot read and is never a candidate.
    expect(data["scope:opening"]).toEqual({
      status: "ambiguous",
      candidates: [
        {
          id: "01920000-0000-7000-8000-000000000032",
          label: "Opening Night Concert",
          detail: "NWS · NWS-S01",
        },
        {
          id: "01920000-0000-7000-8000-000000000033",
          label: "Opening Gala",
          detail: "HBR · HBR-S01",
        },
      ],
    });
    expect(data["kind:inspection"]).toMatchObject({ status: "resolved", id: "Inspection" });
    expect(data["tag:rigging"]).toMatchObject({ status: "resolved", id: "5000.51.02" });
    expect(state.reads.every((db) => db === viewerDb)).toBe(true);
  });

  it("limits scopes to the page's project, kinds to the page's kinds", async () => {
    const result = await resolveQuickAddAction("northwind", {
      target: "record",
      where: { projectId: HBR.id },
      kinds: ["Milestone"],
      tokens,
    });
    const data = result.ok ? result.data : {};
    expect(data["scope:opening"]).toMatchObject({
      status: "resolved",
      id: "01920000-0000-7000-8000-000000000033",
    });
    expect(data["kind:inspection"]).toEqual({ status: "unresolved" });
  });

  it("names the caller with @me, project roots by key, and translated canon names", async () => {
    const result = await resolveQuickAddAction("northwind", {
      target: "record",
      where: {},
      tokens: [
        { type: "person", value: "me" },
        { type: "scope", value: "NWS" },
        { type: "tag", value: "aparejo" },
        { type: "kind", value: "task (es)" },
      ],
    });
    const data = result.ok ? result.data : {};
    expect(data["person:me"]).toMatchObject({ id: "01920000-0000-7000-8000-000000000001" });
    expect(data["scope:nws"]).toMatchObject({ id: "01920000-0000-7000-8000-000000000031" });
    expect(data["tag:aparejo"]).toMatchObject({ id: "5000.51.02", label: "Aparejo" });
    expect(data["kind:task (es)"]).toMatchObject({ id: "Task" });
  });

  it("resolves memberships and roles for a shift, and never kinds", async () => {
    const result = await resolveQuickAddAction("northwind", {
      target: "shift",
      where: {},
      tokens: [
        { type: "person", value: "dana" },
        { type: "tag", value: "tramoyista" },
        { type: "kind", value: "task" },
      ],
    });
    const data = result.ok ? result.data : {};
    expect(data["person:dana"]).toMatchObject({ id: "01920000-0000-7000-8000-000000000012" });
    expect(data["tag:tramoyista"]).toMatchObject({ id: "101" });
    expect(data["kind:task"]).toEqual({ status: "unresolved" });
  });

  it("refuses a caller without the capability, and malformed input", async () => {
    state.ctx = context(["work.record.write"]);
    expect(
      await resolveQuickAddAction("northwind", { target: "shift", where: {}, tokens }),
    ).toEqual({ ok: false, error: { key: "work.errors.quickAdd.capability" } });
    expect(
      await resolveQuickAddAction("northwind", {
        target: "record",
        where: {},
        tokens: [{ type: "date" as "person", value: "x" }],
      }),
    ).toEqual({ ok: false, error: { key: "work.errors.invalid" } });
  });
});

const line = {
  title: "Truss Load Test",
  kind: "Inspection",
  defaultKind: "Task",
  personId: "01920000-0000-7000-8000-000000000002",
  tagId: "5000.51.02",
  scopeNodeId: "01920000-0000-7000-8000-000000000032",
  when: { iso: "2026-10-09", time: "08:00" },
};

describe("quickAddRecordAction", () => {
  it("creates the record with all five fields, in the scope's project and zone", async () => {
    const result = await quickAddRecordAction("northwind", line);
    expect(result).toEqual({ ok: true, data: { key: "NWS-7" } });
    expect(state.created[0]).toMatchObject({
      orgId: "org-1",
      projectId: NWS.id,
      kind: "Inspection",
      title: "Truss Load Test",
      scopeNodeId: "01920000-0000-7000-8000-000000000032",
      urid: "5000.51.02",
      xyz: "X",
      ownerId: "01920000-0000-7000-8000-000000000002",
      dueAt: "2026-10-09T12:00:00.000Z",
      startsAt: null,
    });
  });

  it("creates a plain line as before: the page's kind, the only project, no other fields", async () => {
    state.projects = [NWS];
    await quickAddRecordAction("northwind", {
      title: "Hang truss",
      kind: null,
      defaultKind: "Milestone",
      personId: null,
      tagId: null,
      scopeNodeId: null,
      when: null,
    });
    expect(state.created[0]).toMatchObject({
      projectId: NWS.id,
      kind: "Milestone",
      xyz: "Z",
      ownerId: null,
      scopeNodeId: null,
      urid: null,
      dueAt: null,
    });
  });

  it("refuses what the caller cannot see or the page does not create", async () => {
    const refusal = async (patch: Partial<typeof line> & Record<string, unknown>) => {
      const result = await quickAddRecordAction("northwind", { ...line, ...patch });
      return result.ok ? null : result.error.key;
    };
    expect(await refusal({ personId: "dana" })).toBe("work.errors.invalid");
    state.people = state.people.filter(
      (p) => p.personId !== "01920000-0000-7000-8000-000000000002",
    );
    expect(await refusal({})).toBe("work.errors.quickAdd.person");
    expect(
      await refusal({ personId: null, scopeNodeId: "01920000-0000-7000-8000-000000000034" }),
    ).toBe("work.errors.quickAdd.scope");
    expect(await refusal({ personId: null, projectId: HBR.id })).toBe(
      "work.errors.quickAdd.scopeProject",
    );
    expect(await refusal({ personId: null, scopeNodeId: null })).toBe(
      "work.errors.quickAdd.project",
    );
    expect(await refusal({ personId: null, kinds: ["Milestone"] })).toBe(
      "work.errors.quickAdd.kind",
    );
    expect(await refusal({ personId: null, tagId: "9999.99.99" })).toBe(
      "work.errors.quickAdd.category",
    );
    expect(await refusal({ personId: null, title: "  " })).toBe("work.errors.quickAdd.title");
    expect(state.created).toEqual([]);
  });
});

describe("quickAddShiftAction", () => {
  const shift = {
    rest: "",
    personId: "01920000-0000-7000-8000-000000000012",
    tagId: "101",
    scopeNodeId: "01920000-0000-7000-8000-000000000033",
    when: { iso: "2026-10-09", time: "08:00", endIso: "2026-10-09", endTime: "16:00" },
  };

  it("plans the shift in the scope's project, its times read in that project's zone", async () => {
    expect(await quickAddShiftAction("northwind", shift)).toEqual({ ok: true, data: { id: "s1" } });
    expect(state.shifts[0]).toEqual({
      orgId: "org-1",
      projectId: HBR.id,
      roleCode: "101",
      membershipId: "01920000-0000-7000-8000-000000000012",
      scopeNodeId: "01920000-0000-7000-8000-000000000033",
      timeZone: HBR.timeZone,
      startsAt: "2026-10-09T15:00:00.000Z",
      endsAt: "2026-10-09T23:00:00.000Z",
    });
  });

  it("refuses words a shift has no place for, a missing date and unknown people or roles", async () => {
    const key = async (patch: Record<string, unknown>) => {
      const result = await quickAddShiftAction("northwind", { ...shift, ...patch });
      return result.ok ? null : result.error.key;
    };
    expect(await key({ rest: "Stagehand" })).toBe("crew.shifts.quickAdd.errors.text");
    expect(await key({ when: null })).toBe("crew.shifts.quickAdd.errors.when");
    expect(await key({ tagId: "999" })).toBe("crew.shifts.quickAdd.errors.role");
    state.members = [];
    expect(await key({})).toBe("work.errors.quickAdd.person");
    state.ctx = context(["work.record.write"]);
    expect(await key({})).toBe("work.errors.quickAdd.capability");
    expect(state.shifts).toEqual([]);
  });
});
