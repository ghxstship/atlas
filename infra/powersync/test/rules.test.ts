import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  describeProblem,
  isExternalBucket,
  parseRules,
  planPublication,
  publicationSql,
  type CatalogEntry,
} from "../src/rules.ts";

const RULES = `# comment
bucket_definitions:
  own_person:
    parameters: >-
      SELECT scope_value AS person_id FROM private.sync_scope_grants
      WHERE person_user_id = request.user_id() AND scope_key = 'personIds'
    data:
      - SELECT * FROM app.incidents WHERE reported_by = bucket.person_id

  external_engagement:
    parameters: >-
      SELECT scope_value AS engagement_id FROM sync_scope_grants WHERE person_user_id = request.user_id()
    data:
      - SELECT * FROM time_entries WHERE engagement_id = bucket.engagement_id
      - SELECT id, clock_in FROM app.shifts WHERE engagement_id = bucket.engagement_id
      - SELECT * FROM app.asset_custody WHERE custodian_engagement_id = bucket.engagement_id
      - SELECT * FROM geofence_shapes WHERE project_id = bucket.engagement_id
      - SELECT * FROM kiosk_roster WHERE org_id = bucket.engagement_id
      - SELECT * FROM dup WHERE id = bucket.engagement_id
      - SELECT * FROM app.audit_events WHERE id = bucket.engagement_id
  canon_reference:
    data:
      - SELECT * FROM xpms.gates
`;

const CATALOG: CatalogEntry[] = [
  {
    schema: "private",
    name: "sync_scope_grants",
    kind: "r",
    columns: ["person_user_id", "scope_key", "scope_value"],
  },
  { schema: "app", name: "incidents", kind: "r", columns: ["id"] },
  { schema: "app", name: "time_entries", kind: "r", columns: ["id", "clock_in", "membership_id"] },
  { schema: "api_external", name: "time_entries", kind: "v", columns: ["id", "clock_in"] },
  { schema: "app", name: "shifts", kind: "r", columns: ["id", "clock_in", "membership_id"] },
  { schema: "app", name: "asset_custody", kind: "r", columns: ["id", "note"] },
  { schema: "app", name: "geofence_shapes", kind: "v", columns: ["id"] },
  { schema: "app", name: "dup", kind: "r", columns: ["id"] },
  { schema: "private", name: "dup", kind: "r", columns: ["id"] },
  { schema: "app", name: "audit_events", kind: "p", columns: ["id"] },
  { schema: "api_external", name: "audit_events", kind: "v", columns: ["id"] },
  { schema: "xpms", name: "gates", kind: "r", columns: ["code"] },
];

describe("parseRules", () => {
  it("reads every parameter and data query with its bucket", () => {
    const queries = parseRules(RULES);
    expect(queries.map((q) => [q.bucket, q.kind, q.relation, q.selectsAll])).toEqual([
      ["own_person", "parameters", "private.sync_scope_grants", false],
      ["own_person", "data", "app.incidents", true],
      ["external_engagement", "parameters", "sync_scope_grants", false],
      ["external_engagement", "data", "time_entries", true],
      ["external_engagement", "data", "app.shifts", false],
      ["external_engagement", "data", "app.asset_custody", true],
      ["external_engagement", "data", "geofence_shapes", true],
      ["external_engagement", "data", "kiosk_roster", true],
      ["external_engagement", "data", "dup", true],
      ["external_engagement", "data", "app.audit_events", true],
      ["canon_reference", "data", "xpms.gates", true],
    ]);
    expect(queries[0]?.sql).toBe(
      "SELECT scope_value AS person_id FROM private.sync_scope_grants WHERE person_user_id = request.user_id() AND scope_key = 'personIds'",
    );
  });

  it("parses A17's rules file", () => {
    const text = readFileSync(
      fileURLToPath(new URL("../../../packages/sync/sync-rules.yaml", import.meta.url)),
      "utf8",
    );
    const queries = parseRules(text);
    expect(queries.length).toBeGreaterThan(40);
    expect(new Set(queries.map((q) => q.bucket))).toContain("canon_reference");
  });
});

describe("planPublication", () => {
  const plan = planPublication(parseRules(RULES), CATALOG);

  it("publishes each replicable table once, qualified, and notes partitioned roots", () => {
    expect(plan.tables).toEqual([
      "app.asset_custody",
      "app.audit_events",
      "app.incidents",
      "app.shifts",
      "app.time_entries",
      "private.sync_scope_grants",
      "xpms.gates",
    ]);
    expect(plan.partitioned).toEqual(["app.audit_events"]);
  });

  it("reports every problem", () => {
    expect(plan.problems.map(describeProblem)).toEqual([
      "app.asset_custody in external_engagement: external devices receive every column and api_external has no asset_custody view defining what they may see; add the view (A28's range) and select its columns.",
      "dup: matches app.dup and private.dup; qualify it (buckets external_engagement).",
      "geofence_shapes: app.geofence_shapes is a view; logical replication publishes tables only (buckets external_engagement).",
      "kiosk_roster: no such table in app, private, xpms (buckets external_engagement).",
      "sync_scope_grants: write private.sync_scope_grants; PowerSync reads unqualified names from the public schema (buckets external_engagement).",
      "time_entries: write app.time_entries; PowerSync reads unqualified names from the public schema (buckets external_engagement).",
      "time_entries in external_engagement: SELECT * sends internal columns to external devices (membership_id); select only the api_external.time_entries columns.",
    ]);
  });

  it("classifies external buckets by name", () => {
    expect(isExternalBucket("external_project")).toBe(true);
    expect(isExternalBucket("internal_project")).toBe(false);
  });
});

describe("publicationSql", () => {
  it("creates a password-less replication role and a root-published publication", () => {
    const sql = publicationSql({
      tables: ["app.shifts", "private.sync_scope_grants"],
      partitioned: [],
      problems: [],
    });
    expect(sql).toContain("create role powersync_role with login replication bypassrls;");
    expect(sql).not.toMatch(/password\s+'/i);
    expect(sql).toContain("grant usage on schema app to powersync_role;");
    expect(sql).toContain("grant usage on schema private to powersync_role;");
    expect(sql).toContain("grant select on private.sync_scope_grants to powersync_role;");
    expect(sql).toContain(
      "alter publication powersync set table app.shifts, private.sync_scope_grants;",
    );
    expect(sql).toContain(
      "create publication powersync for table app.shifts, private.sync_scope_grants with (publish_via_partition_root = true);",
    );
  });
});
