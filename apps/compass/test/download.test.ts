import type { SupabaseClient } from "@supabase/supabase-js";
import { getMessages } from "@xos/i18n";
import {
  EXTERNAL_AUDIENCES,
  INTERNAL_AUDIENCES,
  MemoryStore,
  SyncSession,
  TABLE_RULES,
  type Audience,
  type DownloadScope,
} from "@xos/sync";
import { describe, expect, it } from "vitest";
import { downloadAll } from "../src/data/downloader";
import { sourcesFor, toLocalRows } from "../src/data/sources";

type Table = Record<string, unknown>[];

/** A stand-in Supabase client serving fixed rows per schema.relation and recording filters. */
function client(tables: Record<string, Table | Error>) {
  const filters: string[] = [];
  const api = {
    schema: (schema: string) => ({
      from: (relation: string) => {
        const key = `${schema}.${relation}`;
        const conditions: [string, unknown][] = [];
        const query = {
          select: () => query,
          eq: (column: string, value: unknown) => {
            conditions.push([column, value]);
            filters.push(`${key} ${column}=${String(value)}`);
            return query;
          },
          then: (resolve: (v: unknown) => void) => {
            const rows = tables[key];
            if (rows instanceof Error)
              return resolve({ data: null, error: { message: rows.message } });
            const data = (rows ?? []).filter((r) => conditions.every(([c, v]) => r[c] === v));
            return resolve({ data, error: null });
          },
        };
        return query;
      },
    }),
  };
  return { client: api as unknown as SupabaseClient, filters };
}

const crewScope: DownloadScope = {
  audience: "crew",
  personIds: ["person-crew"],
  orgIds: [],
  membershipIds: [],
  readableProjectIds: [],
  engagementIds: ["eng-1"],
  engagedProjectIds: ["proj-1"],
};

describe("sources", () => {
  it("reads externals only through api_external views and everyone caches canon", () => {
    const external = sourcesFor("vendor");
    expect(external.filter((s) => s.schema === "app")).toEqual([]);
    expect(external.map((s) => s.table)).toContain("dock_slots");
    // A member reads api_external only for their own profile rows, which those views limit to the caller (A109).
    expect(
      sourcesFor("field")
        .filter((s) => s.schema === "api_external")
        .map((s) => [s.table, s.personColumn]),
    ).toEqual([
      ["profile_certifications", "person_id"],
      ["profile_documents", "person_id"],
    ]);
    expect(sourcesFor("field").map((s) => s.table)).toEqual(
      expect.arrayContaining(["incident_severities", "emergency_codes", "canon_emergency_codes"]),
    );
  });

  it("selects the column each table's device scope rule checks, for every audience", () => {
    // A row the scope check cannot place is refused, so a source that leaves out the scope column
    // downloads nothing (geofence shapes once lacked org_id and Today said the site had no geofence).
    // Columns the downloader adds after the pull are listed here; a source with a parent takes its project.
    const enriched: Readonly<Record<string, readonly string[]>> = {};
    const audiences: readonly Audience[] = [...INTERNAL_AUDIENCES, ...EXTERNAL_AUDIENCES];
    const gaps: string[] = [];
    for (const audience of audiences) {
      for (const source of sourcesFor(audience)) {
        const rule = TABLE_RULES.find((r) => r.table === source.table);
        if (!rule) {
          gaps.push(`${audience} ${source.table}: no scope rule`);
          continue;
        }
        if (rule.global) continue;
        const selected = Object.fromEntries(
          source.select
            .split(",")
            .map((c) => c.split(":")[0]?.trim() ?? c)
            .map((c) => [c, c === "deleted_at" ? null : "x"]),
        );
        const columns = new Set([
          ...Object.keys(source.map ? source.map(selected) : selected),
          ...(enriched[source.table] ?? []),
          ...(source.parent ? ["project_id"] : []),
        ]);
        const served = rule.anyOf.filter(
          (a) => a.audiences === undefined || a.audiences.includes(audience),
        );
        // Externals share one source list; a table no rule serves for this audience is refused by design.
        if (served.length > 0 && !served.some((a) => columns.has(a.column))) {
          gaps.push(
            `${audience} ${source.table}: needs one of ${served.map((a) => a.column).join(", ")}`,
          );
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  it("names every source in words for the refresh banner, in each locale", () => {
    // The banner once read "Some data did not refresh: geofence_shapes".
    type Names = { compass: { sync: { tables: Record<string, string> } } };
    const tables = new Set(
      [...INTERNAL_AUDIENCES, ...EXTERNAL_AUDIENCES].flatMap((a) =>
        sourcesFor(a).map((s) => s.table),
      ),
    );
    for (const locale of ["en-US", "es-US"] as const) {
      const names = (getMessages(locale) as unknown as Names).compass.sync.tables;
      expect([...tables].filter((t) => typeof names[t] !== "string")).toEqual([]);
    }
  });

  it("maps view rows to local rows and drops rows without an id", () => {
    const custody = sourcesFor("crew").find((s) => s.table === "asset_custody");
    if (!custody) throw new Error("asset custody source missing");
    const row = {
      id: "k1",
      asset_unit_id: "u1",
      engagement_id: "eng-1",
      project_id: "p1",
      held_since: "2027-06-01T12:00:00Z",
    };
    expect(toLocalRows(custody, [row, row, { asset_unit_id: "u2" }])).toEqual([
      {
        id: "k1",
        asset_unit_id: "u1",
        custodian_engagement_id: "eng-1",
        project_id: "p1",
        created_at: "2027-06-01T12:00:00Z",
      },
    ]);
  });
});

describe("REST download", () => {
  it("pulls an external crew member's sources through the scope check", async () => {
    const store = new MemoryStore();
    const session = new SyncSession(store, crewScope);
    const { client: api, filters } = client({
      "api_external.projects": [{ id: "proj-1", name: "Fest", org_id: "o1" }],
      "api_external.shifts": [
        { id: "s1", engagement_id: "eng-1", project_id: "proj-1" },
        { id: "s-other", engagement_id: "eng-9", project_id: "proj-1" },
      ],
      "api_external.run_of_show": [{ id: "ros-1", project_id: "proj-1" }],
      "api_external.cues": [{ id: "c1", run_of_show_id: "ros-1" }],
      "api_external.dock_slots": new Error("permission denied for view dock_slots"),
      "xpms.std_enumeration": [
        {
          record_id: "ENM-097",
          enum_code: "SEV_L1_CRITICAL",
          enum_label: "Level 1 - Critical",
          sort_order: "1",
          color_code: "#D93025",
          enum_domain: "Incident Severity",
        },
        {
          record_id: "ENM-082",
          enum_code: "INSP_PASSED",
          enum_label: "Passed",
          sort_order: "1",
          enum_domain: "Inspection Result",
        },
      ],
      "xpms.emergency_code": [
        {
          code: "CODE_RED",
          label: "Code Red",
          emergency: "Fire",
          swatch: "ecode-red",
          sort_order: "1",
        },
      ],
    });
    const report = await downloadAll({ client: api, session, projectId: null });
    expect(report.failed).toEqual([
      { table: "dock_slots", message: "permission denied for view dock_slots" },
    ]);
    // Another party's shift is refused, and so are the running order and its cue: crew never read them
    // (api_external.cues serves Clients and artists' own set times).
    expect(report.refused).toBe(3);
    expect((await store.list("shifts")).map((r) => r.id)).toEqual(["s1"]);
    expect(await store.get("projects", "proj-1")).toMatchObject({ name: "Fest" });
    expect(await store.get("cues", "c1")).toBeFalsy();
    expect(await store.list("incident_severities")).toEqual([
      {
        id: "ENM-097",
        code: "SEV_L1_CRITICAL",
        label: "Level 1 - Critical",
        sortOrder: 1,
        colorCode: "#D93025",
      },
    ]);
    // Canon codes reach every device, an engaged crew member's too; the org's own codes need a membership.
    expect(await store.get("canon_emergency_codes", "CODE_RED")).toMatchObject({
      label: "Code Red",
      swatch: "ecode-red",
      sort_order: 1,
    });
    expect(await store.list("emergency_codes")).toEqual([]);
    expect(filters).toContain("xpms.std_enumeration enum_domain=Incident Severity");
  });

  it("limits project sources to the current project without removing other projects' rows", async () => {
    const store = new MemoryStore();
    const session = new SyncSession(store, {
      ...crewScope,
      engagedProjectIds: ["proj-1", "proj-2"],
      engagementIds: ["eng-1", "eng-2"],
    });
    await session.ingest("shifts", [{ id: "s2", engagement_id: "eng-2", project_id: "proj-2" }]);
    const { client: api, filters } = client({
      "api_external.shifts": [
        { id: "s1", engagement_id: "eng-1", project_id: "proj-1" },
        { id: "s2", engagement_id: "eng-2", project_id: "proj-2" },
      ],
    });
    await downloadAll({ client: api, session, projectId: "proj-1" });
    expect(filters).toContain("api_external.shifts project_id=proj-1");
    expect((await store.list("shifts")).map((r) => r.id).sort()).toEqual(["s1", "s2"]);
  });

  it("pulls only the tables a live screen asks for (the run of show follows called cues)", async () => {
    const store = new MemoryStore();
    const session = new SyncSession(store, {
      audience: "field",
      personIds: ["person-1"],
      orgIds: ["org-1"],
      membershipIds: ["mem-1"],
      readableProjectIds: ["proj-1"],
      engagementIds: [],
      engagedProjectIds: [],
    });
    const { client: api } = client({
      "app.shifts": [{ id: "s1", membership_id: "mem-1", project_id: "proj-1" }],
      "app.run_of_show": [{ id: "ros-1", org_id: "org-1", project_id: "proj-1" }],
      "app.cues": [
        {
          id: "c1",
          org_id: "org-1",
          project_id: "proj-1",
          run_of_show_id: "ros-1",
          called_at: "2026-10-17T08:03:59Z",
        },
      ],
    });
    const report = await downloadAll({
      client: api,
      session,
      projectId: "proj-1",
      only: ["run_of_show", "cues"],
    });
    expect(report.failed).toEqual([]);
    expect(await store.get("cues", "c1")).toMatchObject({ called_at: "2026-10-17T08:03:59Z" });
    expect(await store.list("shifts")).toEqual([]);
  });

  it("downloads department calls with their cue's project and drops a cleared call (ADR 0131)", async () => {
    const store = new MemoryStore();
    const session = new SyncSession(store, {
      audience: "field",
      personIds: ["person-1"],
      orgIds: ["org-1"],
      membershipIds: ["mem-1"],
      readableProjectIds: ["proj-1"],
      engagementIds: [],
      engagedProjectIds: [],
    });
    const cues = [
      {
        id: "c1",
        org_id: "org-1",
        project_id: "proj-1",
        run_of_show_id: "ros-1",
        deleted_at: null,
      },
      {
        id: "c2",
        org_id: "org-1",
        project_id: "proj-1",
        run_of_show_id: "ros-1",
        deleted_at: "2027-03-13T20:00:00Z",
      },
    ];
    const call = (
      id: string,
      kind: string,
      instruction: string,
      deleted: string | null = null,
    ) => ({
      id,
      org_id: "org-1",
      cue_id: "c1",
      call_kind: kind,
      instruction,
      deleted_at: deleted,
    });
    const first = client({
      "app.cues": cues,
      "app.cue_calls": [
        call("k1", "Lighting", "LX 14 GO"),
        call("k0", "Audio", "Old", "2027-03-13T19:00:00Z"),
      ],
    });
    await downloadAll({
      client: first.client,
      session,
      projectId: null,
      only: ["cues", "cue_calls"],
    });
    // A removed cue and a cleared call are soft-deleted rows row level security still returns; neither is stored.
    expect((await store.list("cues")).map((r) => r.id)).toEqual(["c1"]);
    expect(await store.list("cue_calls")).toEqual([
      expect.objectContaining({ id: "k1", instruction: "LX 14 GO", project_id: "proj-1" }),
    ]);
    // The Lighting call is cleared and added again as a new row: only the new one stays on the device.
    const second = client({
      "app.cues": cues,
      "app.cue_calls": [
        call("k1", "Lighting", "LX 14 GO", "2027-03-13T21:00:00Z"),
        call("k2", "Lighting", "LX 15 GO"),
      ],
    });
    await downloadAll({
      client: second.client,
      session,
      projectId: null,
      only: ["cues", "cue_calls"],
    });
    expect((await store.list("cue_calls")).map((r) => [r.id, r["instruction"]])).toEqual([
      ["k2", "LX 15 GO"],
    ]);
  });

  it("never gives an external device department calls", () => {
    for (const audience of EXTERNAL_AUDIENCES) {
      expect(
        sourcesFor(audience).some((s) => s.table === "cue_calls"),
        audience,
      ).toBe(false);
    }
    expect(sourcesFor("field").some((s) => s.table === "cue_calls")).toBe(true);
  });

  it("keeps a member's own certifications and documents on the device for the Profile (A109)", async () => {
    const store = new MemoryStore();
    const session = new SyncSession(store, {
      audience: "field",
      personIds: ["person-1"],
      orgIds: ["org-1"],
      membershipIds: ["mem-1"],
      readableProjectIds: ["proj-1"],
      engagementIds: [],
      engagedProjectIds: [],
    });
    const { client: api, filters } = client({
      "api_external.my_profile_certifications": [
        { id: "cert-1", person_id: "person-1", source: "Org Record", name: "Arena Rigging" },
        { id: "cert-9", person_id: "person-9", source: "Profile", name: "Not Mine" },
      ],
      "api_external.my_profile_documents": [
        { id: "doc-1", person_id: "person-1", document_type: "Passport", issuer: "US" },
      ],
    });
    const report = await downloadAll({
      client: api,
      session,
      projectId: null,
      only: ["profile_certifications", "profile_documents"],
    });
    expect(report.failed).toEqual([]);
    expect(filters).toContain("api_external.my_profile_certifications person_id=person-1");
    expect((await store.list("profile_certifications")).map((r) => r.id)).toEqual(["cert-1"]);
    expect(await store.get("profile_documents", "doc-1")).toMatchObject({ issuer: "US" });
    // A row for someone else never reaches the device, even if a view returned it.
    await session.ingest("profile_documents", [{ id: "doc-9", person_id: "person-9" }]);
    expect(await store.get("profile_documents", "doc-9")).toBeUndefined();
  });
});
