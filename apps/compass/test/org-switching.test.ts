/**
 * Org switching (Section 4.5.7, A65-011 part 3): a person in several orgs, the combined Today on each item's
 * own calendar, and the proof that the offline database and sync keep each org's rows to that org.
 */
import { DatabaseSync } from "node:sqlite";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  OUTBOX_TABLE,
  Outbox,
  PersistentStore,
  SyncSession,
  type Mutation,
  type Row,
  type SqlExecutor,
} from "@xos/sync";
import { describe, expect, it } from "vitest";
import { downloadAll } from "../src/data/downloader";
import {
  activateOrg,
  cachedContexts,
  isServerUnreachable,
  projectOrgs,
  replayOrgOf,
  resolveIdentity,
  type OrgContext,
} from "../src/data/identity";
import { replayOrg, SupabaseUploader } from "../src/data/uploader";
import {
  combinedToday,
  inOrg,
  isTodayIn,
  itemZone,
  personTimeZone,
  rowOrg,
} from "../src/domain/orgs";

type Result = { data: unknown; error: { message: string } | null };

/** Serves fixed results by "schema.table" (and "rpc.name"), ignoring filters, like the identity tests. */
function identityClient(results: Record<string, Result>) {
  const builder = (key: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      is: () => q,
      in: () => q,
      order: () => q,
      maybeSingle: () => Promise.resolve(results[key] ?? { data: null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve(results[key] ?? { data: [], error: null }),
    };
    return q;
  };
  return {
    from: (t: string) => builder(`app.${t}`),
    rpc: (fn: string) => Promise.resolve(results[`rpc.${fn}`] ?? { data: [], error: null }),
    schema: (s: string) => ({ from: (t: string) => builder(`${s}.${t}`) }),
  } as unknown as SupabaseClient;
}

/** Riley: a Field member of North (org-n), a Field Supervisor of South (org-s), crew for East (org-e). */
const RILEY: Record<string, Result> = {
  "app.people": { data: { id: "riley", full_name: "Riley Park" }, error: null },
  "app.memberships": {
    data: [
      { id: "m-n", org_id: "org-n" },
      { id: "m-s", org_id: "org-s" },
    ],
    error: null,
  },
  "app.membership_roles": {
    data: [
      { membership_id: "m-n", role_id: "field" },
      { membership_id: "m-s", role_id: "field" },
      { membership_id: "m-s", role_id: "supervisor" },
    ],
    error: null,
  },
  "app.role_capabilities": {
    data: [
      { role_id: "field", capability_code: "crew.time_entry.write" },
      { role_id: "supervisor", capability_code: "crew.timesheet.approve" },
    ],
    error: null,
  },
  "app.projects": {
    data: [
      { id: "p-n", name: "North Fest", org_id: "org-n" },
      { id: "p-s", name: "South Pier", org_id: "org-s" },
    ],
    error: null,
  },
  "app.organizations": {
    data: [
      { id: "org-n", name: "North Live" },
      { id: "org-s", name: "South Stages" },
    ],
    error: null,
  },
  "rpc.my_project_role_capabilities": {
    data: [{ project_id: "p-s", capability_code: "safety.incident.dispatch" }],
    error: null,
  },
  "api_external.engagements": {
    data: [
      {
        id: "eng-e",
        org_id: "org-e",
        org_name: "East Events",
        project_id: "p-e",
        project_name: "East Arena",
        role_type: "Crew",
        engagement_state: "Active",
      },
    ],
    error: null,
  },
};

async function riley(preferred: string | null = null) {
  return resolveIdentity(identityClient(RILEY), "user-riley", preferred);
}

describe("a person in several orgs", () => {
  it("resolves one context per org with that org's audience, capabilities and projects", async () => {
    const r = await riley();
    expect(r.contexts.map((c) => [c.orgId, c.kind, c.identity.audience])).toEqual([
      ["org-n", "member", "field"],
      ["org-s", "member", "field-supervisor"],
      ["org-e", "engaged", "crew"],
    ]);
    const south = r.contexts.find((c) => c.orgId === "org-s");
    // The South project role's dispatch stays in South; North holds only North's capabilities.
    expect(south?.identity.capabilities).toEqual([
      "crew.time_entry.write",
      "crew.timesheet.approve",
      "safety.incident.dispatch",
    ]);
    expect(r.contexts[0]?.identity.capabilities).toEqual(["crew.time_entry.write"]);
    expect(r.contexts.map((c) => c.orgName)).toEqual(["North Live", "South Stages", "East Events"]);
    expect(r.contexts.map((c) => c.scope.orgIds)).toEqual([["org-n"], ["org-s"], []]);
    expect(r.contexts[2]?.scope.engagementIds).toEqual(["eng-e"]);
    // The first org is active unless the device remembers another.
    expect(r.orgId).toBe("org-n");
    expect(r.projects).toEqual([{ id: "p-n", name: "North Fest" }]);
  });

  it("activates the remembered org and falls back to the first for one it no longer has", async () => {
    const r = await riley("org-s");
    expect(r.orgId).toBe("org-s");
    expect(r.identity.membershipId).toBe("m-s");
    expect(activateOrg(r.contexts, "org-gone").orgId).toBe("org-n");
    expect(() => activateOrg([], null)).toThrow("No organization");
    expect(replayOrgOf(r)).toBe("org-s");
    expect(replayOrgOf(activateOrg(r.contexts, "org-e"))).toBeNull();
    expect(replayOrgOf(null)).toBeNull();
    expect(projectOrgs(r.contexts).get("p-e")).toBe("org-e");
  });

  it("opens offline on the contexts cached at the last sign-in, never on a refusal or a bad row", async () => {
    const r = await riley();
    expect(cachedContexts({ id: "user-riley", contexts: r.contexts })).toEqual(r.contexts);
    expect(activateOrg(cachedContexts({ contexts: r.contexts }) ?? [], "org-s").orgId).toBe(
      "org-s",
    );
    expect(cachedContexts(undefined)).toBeNull();
    expect(cachedContexts({ contexts: [] })).toBeNull();
    expect(cachedContexts({ contexts: [{ orgId: "org-n", kind: "boss" }] })).toBeNull();
    expect(
      isServerUnreachable("fetch failed: UnexpectedException: Could not connect to the server."),
    ).toBe(true);
    expect(isServerUnreachable("TypeError: Network request failed")).toBe(true);
    expect(isServerUnreachable("JWT expired")).toBe(false);
    expect(isServerUnreachable("No person is linked to this sign-in.")).toBe(false);
  });

  it("opens a member's own orgs when the engagement read fails, and refuses a sign-in with neither", async () => {
    const failing = {
      ...RILEY,
      "api_external.engagements": { data: null, error: { message: "x" } },
    };
    const r = await resolveIdentity(identityClient(failing), "user-riley");
    expect(r.contexts.map((c) => c.orgId)).toEqual(["org-n", "org-s"]);
    await expect(
      resolveIdentity(
        identityClient({
          "app.people": RILEY["app.people"] as Result,
          "app.memberships": { data: [], error: null },
          "api_external.engagements": { data: null, error: { message: "denied" } },
        }),
        "u",
      ),
    ).rejects.toMatchObject({ step: "engagements" });
  });
});

/** An offline database on node:sqlite, the same PersistentStore Compass runs on SQLCipher. */
function sqlite(): { exec: SqlExecutor; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const exec: SqlExecutor = {
    transaction: (statements) => {
      db.exec("begin");
      try {
        for (const s of statements) db.prepare(s.sql).run(...(s.params as (string | null)[]));
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
      return Promise.resolve();
    },
    all: (sql, params = []) =>
      Promise.resolve(
        db.prepare(sql).all(...(params as (string | null)[])) as Record<string, unknown>[],
      ),
  };
  return { exec, db };
}

/** A REST stand-in serving every org's rows, as row level security would to a person in all of them. */
function serverClient(tables: Record<string, Record<string, unknown>[]>) {
  return {
    schema: (schema: string) => ({
      from: (relation: string) => {
        const q = {
          select: () => q,
          eq: () => q,
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: tables[`${schema}.${relation}`] ?? [], error: null }),
        };
        return q;
      },
    }),
  } as unknown as SupabaseClient;
}

const SERVER = {
  "app.projects": [
    { id: "p-n", org_id: "org-n", name: "North Fest", time_zone: "America/New_York" },
    { id: "p-s", org_id: "org-s", name: "South Pier", time_zone: "America/Los_Angeles" },
    // A project of an org Riley has no part in, as a leaky source might send it.
    { id: "p-x", org_id: "org-x", name: "Other Tenant", time_zone: "UTC" },
  ],
  "app.shifts": [
    { id: "s-n", org_id: "org-n", project_id: "p-n", membership_id: "m-n" },
    { id: "s-s", org_id: "org-s", project_id: "p-s", membership_id: "m-s" },
    { id: "s-x", org_id: "org-x", project_id: "p-x", membership_id: "m-x" },
  ],
  "app.zones": [
    { id: "z-n", org_id: "org-n", code: "N1" },
    { id: "z-s", org_id: "org-s", code: "S1" },
    { id: "z-x", org_id: "org-x", code: "X1" },
  ],
  "app.memberships": [
    { id: "m-n", org_id: "org-n", people: { full_name: "Riley Park" } },
    { id: "m-x", org_id: "org-x", people: { full_name: "Someone Else" } },
  ],
  "api_external.projects": [
    { id: "p-e", org_id: "org-e", name: "East Arena", time_zone: "Asia/Tokyo" },
  ],
  "api_external.shifts": [
    { id: "s-e", engagement_id: "eng-e", project_id: "p-e" },
    { id: "s-e-other", engagement_id: "eng-other", project_id: "p-e" },
  ],
  "app.emergency_codes": [
    {
      id: "ec-n",
      org_id: "org-n",
      code: "CODE_RED",
      label: "Fire",
      emergency: "Fire",
      sort_order: 1,
    },
    {
      id: "ec-s",
      org_id: "org-s",
      code: "CODE_RED",
      label: "Red",
      emergency: "Fire",
      sort_order: 2,
    },
    // A code South removed: the server keeps the row so adopting again never brings it back.
    {
      id: "ec-s-gone",
      org_id: "org-s",
      code: "CODE_BLUE",
      label: "Blue",
      emergency: "Medical",
      sort_order: 1,
      deleted_at: "2026-10-20T12:00:00Z",
    },
    {
      id: "ec-x",
      org_id: "org-x",
      code: "CODE_RED",
      label: "Theirs",
      emergency: "Fire",
      sort_order: 1,
    },
  ],
  "xpms.emergency_code": [
    { code: "CODE_RED", label: "Code Red", emergency: "Fire", swatch: "ecode-red", sort_order: 1 },
  ],
};

describe("tenancy on the device: no row crosses from one org into another", () => {
  it("stores each org's rows under its own scope, refuses every other tenant's, and survives a restart", async () => {
    const r = await riley();
    const { exec } = sqlite();
    const store = await PersistentStore.open(exec);
    const session = new SyncSession(
      store,
      r.contexts.map((c) => c.scope),
    );
    const report = await downloadAll({ client: serverClient(SERVER), session, projectId: null });
    expect(report.failed).toEqual([]);
    const ids = async (table: string) => (await store.list(table)).map((x) => x.id).sort();
    // Internal and external rows of the same table are merged, never one replacing the other.
    expect(await ids("projects")).toEqual(["p-e", "p-n", "p-s"]);
    expect(await ids("shifts")).toEqual(["s-e", "s-n", "s-s"]);
    expect(await ids("zones")).toEqual(["z-n", "z-s"]);
    // Each org's own emergency codes; another tenant's is refused and a removed code never reaches the device.
    expect(await ids("emergency_codes")).toEqual(["ec-n", "ec-s"]);
    expect(await ids("canon_emergency_codes")).toEqual(["CODE_RED"]);
    expect(await ids("kiosk_roster")).toEqual(["m-n"]);
    expect(report.refused).toBeGreaterThanOrEqual(5);
    // The rows are in SQLite: a fresh open (an app restart) reads the same rows, no other tenant's.
    const reopened = await PersistentStore.open(exec);
    expect((await reopened.list("shifts")).map((x) => x.id).sort()).toEqual(["s-e", "s-n", "s-s"]);
    expect(await reopened.get("zones", "z-x")).toBeUndefined();
  });

  it("shows only the active org's rows on one-org screens, canon everywhere", async () => {
    const r = await riley("org-s");
    const orgs = projectOrgs(r.contexts);
    const rows: Row[] = [
      { id: "s-n", project_id: "p-n" },
      { id: "s-s", project_id: "p-s" },
      { id: "z-n", org_id: "org-n" },
      { id: "s-e", project_id: "p-e" },
      { id: "CODE_RED" },
    ];
    expect(rows.filter((x) => inOrg(x, r.orgId, orgs)).map((x) => x.id)).toEqual([
      "s-s",
      "CODE_RED",
    ]);
    expect(rows.filter((x) => inOrg(x, null, orgs))).toHaveLength(5);
    expect(rowOrg({ project_id: "p-unknown" }, orgs)).toBeNull();
    expect(rowOrg({ org_id: "org-n", project_id: "p-s" }, orgs)).toBe("org-n");
  });

  it("purges an org's rows when the membership there ends, keeping the outbox", async () => {
    const r = await riley();
    const store = await PersistentStore.open(sqlite().exec);
    const session = new SyncSession(
      store,
      r.contexts.map((c) => c.scope),
    );
    await downloadAll({ client: serverClient(SERVER), session, projectId: null });
    await new Outbox(store).enqueue({
      op: "rpc",
      target: "app.accept_shift",
      table: "shifts",
      rowId: "s-s",
      payload: { p_shift_id: "s-s", device_org_id: "org-s" },
    });
    const withoutSouth = r.contexts.filter((c) => c.orgId !== "org-s");
    expect(await session.narrow(withoutSouth.map((c) => c.scope))).toBeGreaterThan(0);
    expect((await store.list("shifts")).map((x) => x.id).sort()).toEqual(["s-e", "s-n"]);
    expect(await store.get("zones", "z-s")).toBeUndefined();
    expect(await store.list(OUTBOX_TABLE)).toHaveLength(1);
  });

  it("replays a queued write in the org it was queued in, whichever org is active at upload", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const client = {
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return Promise.resolve({ data: {}, error: null, status: 200 });
      },
    } as unknown as SupabaseClient;
    let active: string | null = "org-n";
    const uploader = new SupabaseUploader({
      client,
      functionsUrl: "https://example.test",
      accessToken: () => Promise.resolve(null),
      orgId: () => active,
      deviceId: "device-1",
      clock: { wallNow: () => 0, monotonicNow: () => 0, bootId: () => "boot" },
    });
    const queued = (payload: Record<string, unknown>): Mutation => ({
      id: "mut-1",
      seq: 1,
      op: "rpc",
      target: "app.accept_shift",
      table: "shifts",
      rowId: "s-s",
      payload,
      base: null,
      policy: "cas",
      dependsOn: [],
      queuedAt: "",
      attempts: 0,
      nextAttemptAt: 0,
      status: "pending",
      lastError: null,
      serverRow: null,
    });
    // Queued in South, uploaded after the person switched to North.
    await uploader.upload(queued({ p_shift_id: "s-s", device_org_id: "org-s" }));
    expect(calls[0]).toMatchObject({ name: "apply_sync_mutation", args: { p_org_id: "org-s" } });
    expect(calls[0]?.args["p_args"]).toEqual({ p_shift_id: "s-s" });
    // Queued in an engaging org: called directly, never through a member org's replay ledger.
    await uploader.upload(queued({ p_shift_id: "s-e", device_org_id: null }));
    expect(calls[1]).toMatchObject({ name: "accept_shift", args: { p_shift_id: "s-e" } });
    // A write queued before writes carried their org uses the org active at upload, as before.
    active = "org-n";
    expect(replayOrg(queued({}), () => active)).toBe("org-n");
  });
});

describe("the combined Today on each item's own calendar (A71)", () => {
  // 2027-06-12 01:30 UTC: still the 11th in New York and Los Angeles, already the 12th in Tokyo.
  const NOW = Date.parse("2027-06-12T01:30:00Z");
  const orgs = [
    {
      orgId: "org-n",
      orgName: "North Live",
      projectIds: ["p-n"],
      me: { membershipId: "m-n", engagementIds: [] },
    },
    {
      orgId: "org-s",
      orgName: "South Stages",
      projectIds: ["p-s"],
      me: { membershipId: "m-s", engagementIds: [] },
    },
    {
      orgId: "org-e",
      orgName: "East Events",
      projectIds: ["p-e"],
      me: { membershipId: null, engagementIds: ["eng-e"] },
    },
  ];
  const projects = [
    { id: "p-n", time_zone: "America/New_York" },
    { id: "p-s", time_zone: "America/Los_Angeles" },
    { id: "p-e", time_zone: "Asia/Tokyo" },
  ];
  const shift = (
    id: string,
    project: string,
    who: Record<string, string>,
    starts: string,
    ends: string,
  ) => ({
    id,
    project_id: project,
    starts_at: starts,
    ends_at: ends,
    shift_state: "Published",
    ...who,
  });
  const shifts = [
    // 21:00 to 23:30 in New York on the 11th: today there, though the UTC date is the 12th.
    shift(
      "n-tonight",
      "p-n",
      { membership_id: "m-n" },
      "2027-06-12T01:00:00Z",
      "2027-06-12T03:30:00Z",
    ),
    // 09:00 New York on the 12th: tomorrow there, so not on today's list.
    shift(
      "n-tomorrow",
      "p-n",
      { membership_id: "m-n" },
      "2027-06-12T13:00:00Z",
      "2027-06-12T21:00:00Z",
    ),
    // 20:00 Los Angeles on the 11th, a colleague's: never mine.
    shift(
      "s-colleague",
      "p-s",
      { membership_id: "m-other" },
      "2027-06-12T03:00:00Z",
      "2027-06-12T07:00:00Z",
    ),
    // 10:00 Tokyo on the 12th: today in Tokyo.
    shift(
      "e-today",
      "p-e",
      { engagement_id: "eng-e" },
      "2027-06-12T01:00:00Z",
      "2027-06-12T09:00:00Z",
    ),
  ];

  it("lists each org's own shifts, day sheets and next cue on that project's calendar", () => {
    const groups = combinedToday({
      orgs,
      activeOrgId: "org-s",
      shifts,
      sheets: [
        { id: "d-n", project_id: "p-n", day: "2027-06-11", body: "Doors at 19:00" },
        { id: "d-n-utc", project_id: "p-n", day: "2027-06-12", body: "UTC's date, not New York's" },
        { id: "d-e", project_id: "p-e", day: "2027-06-12", body: "Tokyo load-in" },
      ],
      cues: [
        {
          id: "c1",
          run_of_show_id: "r",
          position: 1,
          label: "Walk-in",
          planned_at: "2027-06-12T01:00:00Z",
          duration: null,
          called_at: "2027-06-12T01:00:00Z",
          project_id: "p-n",
        },
        {
          id: "c2",
          run_of_show_id: "r",
          position: 2,
          label: "Headliner",
          planned_at: "2027-06-12T02:15:00Z",
          duration: null,
          called_at: null,
          project_id: "p-n",
        },
      ],
      projects,
      personZone: "America/Chicago",
      nowMs: NOW,
    });
    // The active org leads, the rest by name.
    expect(groups.map((g) => g.orgId)).toEqual(["org-s", "org-e", "org-n"]);
    const north = groups.find((g) => g.orgId === "org-n");
    expect(north?.shifts.map((s) => s.id)).toEqual(["n-tonight"]);
    expect(north?.working?.id).toBe("n-tonight");
    expect(north?.sheets.map((d) => d.id)).toEqual(["d-n"]);
    expect(north?.nextCue?.label).toBe("Headliner");
    const south = groups.find((g) => g.orgId === "org-s");
    expect(south?.empty).toBe(true);
    expect(south?.active).toBe(true);
    const east = groups.find((g) => g.orgId === "org-e");
    expect(east?.shifts.map((s) => s.id)).toEqual(["e-today"]);
    expect(east?.sheets.map((d) => d.id)).toEqual(["d-e"]);
  });

  it("places an item without a project zone on the person's own calendar", () => {
    expect(itemZone(null, null, "America/Chicago")).toBe("America/Chicago");
    expect(itemZone("Europe/Berlin", "Asia/Tokyo", "UTC")).toBe("Europe/Berlin");
    expect(itemZone("Not/AZone", "Asia/Tokyo", "UTC")).toBe("Asia/Tokyo");
    // 20:30 in Chicago on the 11th: today for the person, though UTC says the 12th.
    expect(isTodayIn("2027-06-12T01:30:00Z", "America/Chicago", NOW)).toBe(true);
    expect(isTodayIn("2027-06-12T01:30:00Z", "UTC", Date.parse("2027-06-11T23:00:00Z"))).toBe(
      false,
    );
    expect(isTodayIn("not a date", "UTC", NOW)).toBe(false);
    expect(personTimeZone("America/Denver", "Europe/Paris")).toBe("America/Denver");
    expect(personTimeZone(null, "Europe/Paris")).toBe("Europe/Paris");
    expect(personTimeZone("Nowhere/Land", undefined)).toBe("UTC");
  });

  it("keeps a group for an org with nothing today, so every org stays in view", () => {
    const empty: OrgContext[] = [];
    expect(
      combinedToday({
        orgs: [],
        activeOrgId: null,
        shifts: [],
        sheets: [],
        cues: [],
        projects: [],
        personZone: "UTC",
        nowMs: NOW,
      }),
    ).toEqual([]);
    expect(empty).toEqual([]);
    const only = combinedToday({
      orgs: orgs.slice(0, 1),
      activeOrgId: null,
      shifts: [],
      sheets: [],
      cues: [],
      projects,
      personZone: "UTC",
      nowMs: NOW,
    });
    expect(only).toMatchObject([{ orgId: "org-n", empty: true, nextCue: null, working: null }]);
  });
});
