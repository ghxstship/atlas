import { describe, expect, it } from "vitest";
import {
  admits,
  EXTERNAL_AUDIENCES,
  filterDownload,
  isInternal,
  MemoryStore,
  Outbox,
  ruleFor,
  SyncSession,
  type Audience,
  type DownloadScope,
} from "../src";
import { sequentialIds } from "./support";

const internal: DownloadScope = {
  audience: "field",
  personIds: ["person-me"],
  orgIds: ["org-1"],
  membershipIds: ["mem-me"],
  readableProjectIds: ["proj-1"],
  engagementIds: [],
  engagedProjectIds: [],
};

function external(audience: Audience, engagementIds = ["eng-mine"]): DownloadScope {
  return {
    audience,
    personIds: ["person-ext"],
    orgIds: [],
    membershipIds: [],
    readableProjectIds: [],
    engagementIds,
    engagedProjectIds: engagementIds.length > 0 ? ["proj-1"] : [],
  };
}

describe("audiences", () => {
  it("splits internal and external audiences", () => {
    expect(isInternal("field-supervisor")).toBe(true);
    for (const a of EXTERNAL_AUDIENCES) expect(isInternal(a)).toBe(false);
  });
});

describe("download scope (Section 8.7)", () => {
  it("admits internal rows by membership or readable project", () => {
    expect(
      admits("shifts", { id: "s1", membership_id: "mem-me", project_id: "proj-9" }, internal),
    ).toBe(true);
    expect(
      admits("shifts", { id: "s2", membership_id: "mem-other", project_id: "proj-1" }, internal),
    ).toBe(true);
    expect(
      admits("shifts", { id: "s3", membership_id: "mem-other", project_id: "proj-9" }, internal),
    ).toBe(false);
  });

  it("admits an external user's own engagement rows only", () => {
    const crew = external("crew");
    expect(
      admits("shifts", { id: "s1", engagement_id: "eng-mine", project_id: "proj-1" }, crew),
    ).toBe(true);
    expect(
      admits("shifts", { id: "s2", engagement_id: "eng-other", project_id: "proj-1" }, crew),
    ).toBe(false);
    expect(
      admits("shifts", { id: "s3", membership_id: "mem-me", project_id: "proj-1" }, crew),
    ).toBe(false);
  });

  it("never gives an external user project-wide internal data", () => {
    const vendor = external("vendor");
    expect(
      admits("incidents", { id: "i1", project_id: "proj-1", reported_by: "someone" }, vendor),
    ).toBe(false);
    expect(admits("access_grid", { id: "g1", project_id: "proj-1" }, vendor)).toBe(false);
    expect(admits("inspections", { id: "x", project_id: "proj-1" }, vendor)).toBe(false);
    expect(admits("time_entries", { id: "t", project_id: "proj-1" }, vendor)).toBe(false);
  });

  it("follows the role table: who sees run of show, dock slots and party badges", () => {
    const ros = { id: "r1", project_id: "proj-1" };
    expect(admits("run_of_show", ros, external("client"))).toBe(true);
    expect(admits("run_of_show", ros, external("artist"))).toBe(true);
    expect(admits("run_of_show", ros, external("vendor"))).toBe(false);
    expect(admits("run_of_show", ros, external("sponsor"))).toBe(false);
    expect(admits("dock_slots", { id: "d1", engagement_id: "eng-mine" }, external("vendor"))).toBe(
      true,
    );
    expect(admits("dock_slots", { id: "d1", engagement_id: "eng-mine" }, external("crew"))).toBe(
      false,
    );
    const partyBadge = { id: "c1", holder_person_id: "band-member", engagement_id: "eng-mine" };
    expect(admits("credentials", partyBadge, external("artist-representative"))).toBe(true);
    expect(admits("credentials", partyBadge, external("crew"))).toBe(false);
    expect(
      admits("credentials", { id: "c2", holder_person_id: "person-ext" }, external("crew")),
    ).toBe(true);
  });

  it("denies everything once the engagement closes", () => {
    const closed = external("crew", []);
    expect(
      admits("shifts", { id: "s1", engagement_id: "eng-mine", project_id: "proj-1" }, closed),
    ).toBe(false);
    expect(admits("radio_channels", { id: "rc", project_id: "proj-1" }, closed)).toBe(false);
  });

  it("refuses unknown tables, admits canon reference tables and ignores non-string keys", () => {
    expect(admits("payroll_runs", { id: "x", org_id: "org-1" }, internal)).toBe(false);
    expect(admits("canon_emergency_codes", { id: "CODE_RED" }, external("sponsor"))).toBe(true);
    expect(admits("shifts", { id: "s", membership_id: 42 }, internal)).toBe(false);
    expect(ruleFor("shifts")?.anyOf.length).toBeGreaterThan(0);
  });

  it("admits an org's own emergency codes only to its members (WP18)", () => {
    expect(admits("emergency_codes", { id: "ec-1", org_id: "org-1" }, internal)).toBe(true);
    expect(admits("emergency_codes", { id: "ec-2", org_id: "org-2" }, internal)).toBe(false);
    expect(admits("emergency_codes", { id: "ec-1", org_id: "org-1" }, external("crew"))).toBe(
      false,
    );
    expect(admits("emergency_codes", { id: "ec-3" }, internal)).toBe(false);
    // The audience gate on its own: an engaged person whose scope somehow named the org still gets none.
    expect(
      admits(
        "emergency_codes",
        { id: "ec-1", org_id: "org-1" },
        { ...external("crew"), orgIds: ["org-1"] },
      ),
    ).toBe(false);
  });

  it("filters a downloaded batch", () => {
    const result = filterDownload(
      "shifts",
      [
        { id: "a", engagement_id: "eng-mine" },
        { id: "b", engagement_id: "eng-other" },
      ],
      external("staff"),
    );
    expect(result.kept.map((r) => r.id)).toEqual(["a"]);
    expect(result.refused.map((r) => r.id)).toEqual(["b"]);
  });
});

describe("SyncSession", () => {
  it("writes admitted rows, refuses others and keeps rows with queued writes", async () => {
    const store = new MemoryStore();
    const outbox = new Outbox(store, { newId: sequentialIds() });
    const session = new SyncSession(store, external("crew"));
    await outbox.enqueue({
      op: "update",
      table: "shifts",
      rowId: "s1",
      payload: { note: "mine" },
      optimistic: { id: "s1", engagement_id: "eng-mine", note: "mine" },
    });
    const report = await session.ingest("shifts", [
      { id: "s1", engagement_id: "eng-mine", note: "server" },
      { id: "s2", engagement_id: "eng-mine" },
      { id: "s3", engagement_id: "eng-other" },
    ]);
    expect(report).toEqual({ written: 1, refused: 1, deferred: 1, removed: 0 });
    expect((await store.get("shifts", "s1"))?.["note"]).toBe("mine");
    expect(await store.get("shifts", "s3")).toBeUndefined();
    expect(session.scope.audience).toBe("crew");
  });

  it("replaces a table from a full snapshot, keeping rows with queued writes", async () => {
    const store = new MemoryStore();
    const session = new SyncSession(store, internal);
    await session.ingest("shifts", [
      { id: "s1", membership_id: "mem-me" },
      { id: "s2", membership_id: "mem-me" },
      { id: "s3", membership_id: "mem-me" },
    ]);
    const outbox = new Outbox(store, { newId: sequentialIds() });
    await outbox.enqueue({ op: "update", table: "shifts", rowId: "s3", payload: { note: "x" } });
    const report = await session.replace("shifts", [{ id: "s1", membership_id: "mem-me" }]);
    expect(report).toMatchObject({ written: 1, removed: 1 });
    expect((await store.list("shifts")).map((r) => r.id).sort()).toEqual(["s1", "s3"]);
  });

  it("applies server deletions except for rows with queued writes", async () => {
    const store = new MemoryStore();
    const session = new SyncSession(store, internal);
    await session.ingest("shifts", [
      { id: "s1", membership_id: "mem-me" },
      { id: "s2", membership_id: "mem-me" },
    ]);
    const outbox = new Outbox(store, { newId: sequentialIds() });
    await outbox.enqueue({ op: "update", table: "shifts", rowId: "s2", payload: { note: "x" } });
    const report = await session.ingest("shifts", [], ["s1", "s2", "missing"]);
    expect(report.removed).toBe(1);
    expect(await store.get("shifts", "s2")).toBeDefined();
  });

  it("removes a stored row the server now says is out of scope", async () => {
    const store = new MemoryStore();
    await store.transaction((tx) => tx.put("shifts", { id: "s1", engagement_id: "eng-mine" }));
    const session = new SyncSession(store, external("crew"));
    const report = await session.ingest("shifts", [{ id: "s1", engagement_id: "eng-other" }]);
    expect(report).toEqual({ written: 0, refused: 1, deferred: 0, removed: 1 });
  });

  it("refuses to let download write the outbox", async () => {
    const session = new SyncSession(new MemoryStore(), internal);
    await expect(session.ingest("_outbox", [])).rejects.toThrow("never written by download");
  });

  it("purges rows when the engagement completes and Compass access ends", async () => {
    const store = new MemoryStore();
    const session = new SyncSession(store, external("crew"));
    await session.ingest("shifts", [{ id: "s1", engagement_id: "eng-mine" }]);
    await session.ingest("canon_emergency_codes", [{ id: "CODE_RED" }]);
    expect(await session.narrow(external("crew", []))).toBe(1);
    expect(await store.tables()).toEqual(["canon_emergency_codes"]);
  });

  it("wipes the store, queue included, on remote sign-out", async () => {
    const store = new MemoryStore();
    const outbox = new Outbox(store, { newId: sequentialIds() });
    const session = new SyncSession(store, internal);
    await outbox.enqueue({
      op: "insert",
      table: "clock_punches",
      rowId: "p1",
      payload: {},
      optimistic: { id: "p1", membership_id: "mem-me" },
    });
    expect(await session.remoteSignOut()).toBe(1);
    expect(await store.tables()).toEqual([]);
  });
});

describe("SyncSession across several orgs (Section 4.5.7 org switching)", () => {
  const orgA: DownloadScope = {
    ...internal,
    orgIds: ["org-a"],
    membershipIds: ["mem-a"],
    readableProjectIds: ["proj-a"],
  };
  const orgB: DownloadScope = {
    ...internal,
    audience: "field-supervisor",
    orgIds: ["org-b"],
    membershipIds: ["mem-b"],
    readableProjectIds: ["proj-b"],
  };
  const engagedByC: DownloadScope = {
    ...external("crew", ["eng-c"]),
    engagedProjectIds: ["proj-c"],
  };

  it("stores each org's rows under that org's scope and refuses an org the person has no part in", async () => {
    const store = new MemoryStore();
    const session = new SyncSession(store, [orgA, orgB, engagedByC]);
    expect(session.scope).toBe(orgA);
    expect(session.scopes).toHaveLength(3);
    const report = await session.ingest("shifts", [
      { id: "a1", org_id: "org-a", project_id: "proj-a", membership_id: null },
      { id: "b1", org_id: "org-b", project_id: "proj-b", membership_id: "mem-b" },
      { id: "c1", project_id: "proj-c", engagement_id: "eng-c" },
      { id: "x1", org_id: "org-x", project_id: "proj-x", membership_id: "mem-x" },
    ]);
    expect(report).toMatchObject({ written: 3, refused: 1 });
    expect((await store.list("shifts")).map((r) => r.id).sort()).toEqual(["a1", "b1", "c1"]);
    // Org-level reference rows follow the org too: org B's zones are stored, org X's never.
    await session.ingest("zones", [
      { id: "z-b", org_id: "org-b" },
      { id: "z-x", org_id: "org-x" },
    ]);
    expect((await store.list("zones")).map((r) => r.id)).toEqual(["z-b"]);
  });

  it("purges only the rows of an org whose membership ended, and never device-local tables", async () => {
    const store = new MemoryStore();
    const session = new SyncSession(store, [orgA, orgB]);
    await session.ingest("shifts", [
      { id: "a1", org_id: "org-a", project_id: "proj-a" },
      { id: "b1", org_id: "org-b", project_id: "proj-b" },
    ]);
    await store.transaction((tx) => tx.put("_uploads", { id: "u1", path: "org-b/x.jpg" }));
    expect(await session.narrow([orgA])).toBe(1);
    expect((await store.list("shifts")).map((r) => r.id)).toEqual(["a1"]);
    expect(await store.get("_uploads", "u1")).toBeDefined();
    await expect(session.ingest("_uploads", [])).rejects.toThrow("device-local");
    expect(() => new SyncSession(store, []).scope).toThrow("at least one scope");
  });
});
