import type { SupabaseClient } from "@supabase/supabase-js";
import { MemoryStore, SyncSession, type DownloadScope } from "@xos/sync";
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
            if (rows instanceof Error) return resolve({ data: null, error: { message: rows.message } });
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
    expect(sourcesFor("field").every((s) => s.schema !== "api_external")).toBe(true);
    expect(sourcesFor("field").map((s) => s.table)).toEqual(expect.arrayContaining(["incident_severities", "emergency_codes"]));
  });

  it("maps view rows to local rows and drops rows without an id", () => {
    const projects = sourcesFor("crew").find((s) => s.table === "projects");
    if (!projects) throw new Error("projects source missing");
    expect(toLocalRows(projects, [{ project_id: "p1", project_name: "Fest", org_id: "o1" }, { project_id: "p1", project_name: "Fest", org_id: "o1" }, { project_name: "x" }])).toEqual([
      { id: "p1", name: "Fest", org_id: "o1" },
    ]);
  });
});

describe("REST download", () => {
  it("pulls an external crew member's sources through the scope check", async () => {
    const store = new MemoryStore();
    const session = new SyncSession(store, crewScope);
    const { client: api, filters } = client({
      "api_external.engagements": [{ project_id: "proj-1", project_name: "Fest", org_id: "o1" }],
      "api_external.shifts": [
        { id: "s1", engagement_id: "eng-1", project_id: "proj-1" },
        { id: "s-other", engagement_id: "eng-9", project_id: "proj-1" },
      ],
      "api_external.run_of_show": [{ id: "ros-1", project_id: "proj-1" }],
      "api_external.cues": [{ id: "c1", run_of_show_id: "ros-1" }],
      "api_external.dock_slots": new Error("permission denied for view dock_slots"),
      "xpms.std_enumeration": [
        { record_id: "ENM-097", enum_code: "SEV_L1_CRITICAL", enum_label: "Level 1 - Critical", sort_order: "1", color_code: "#D93025", enum_domain: "Incident Severity" },
        { record_id: "ENM-082", enum_code: "INSP_PASSED", enum_label: "Passed", sort_order: "1", enum_domain: "Inspection Result" },
      ],
      "xpms.emergency_code": [{ code: "CODE_RED", name: "Code Red" }],
    });
    const report = await downloadAll({ client: api, session, projectId: null });
    expect(report.failed).toEqual([{ table: "dock_slots", message: "permission denied for view dock_slots" }]);
    expect(report.refused).toBe(1);
    expect((await store.list("shifts")).map((r) => r.id)).toEqual(["s1"]);
    expect(await store.get("cues", "c1")).toMatchObject({ project_id: "proj-1" });
    expect(await store.list("incident_severities")).toEqual([{ id: "ENM-097", code: "SEV_L1_CRITICAL", label: "Level 1 - Critical", sortOrder: 1, colorCode: "#D93025" }]);
    expect(await store.get("emergency_codes", "CODE_RED")).toMatchObject({ name: "Code Red" });
    expect(filters).toContain("xpms.std_enumeration enum_domain=Incident Severity");
  });

  it("limits project sources to the current project without removing other projects' rows", async () => {
    const store = new MemoryStore();
    const session = new SyncSession(store, { ...crewScope, engagedProjectIds: ["proj-1", "proj-2"], engagementIds: ["eng-1", "eng-2"] });
    await session.ingest("shifts", [{ id: "s2", engagement_id: "eng-2", project_id: "proj-2" }]);
    const { client: api, filters } = client({
      "api_external.shifts": [{ id: "s1", engagement_id: "eng-1", project_id: "proj-1" }, { id: "s2", engagement_id: "eng-2", project_id: "proj-2" }],
    });
    await downloadAll({ client: api, session, projectId: "proj-1" });
    expect(filters).toContain("api_external.shifts project_id=proj-1");
    expect((await store.list("shifts")).map((r) => r.id).sort()).toEqual(["s1", "s2"]);
  });
});
