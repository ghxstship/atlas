/**
 * A07 handlers (Projects, Home, Activity) end to end through the runtime, against an in-memory
 * stand-in for the caller's Supabase client that supports the query builder calls they make.
 * Every response is checked against openapi/v1.json with expectContract.
 */
import { describe, expect, it } from "vitest";
import { handlers as activity } from "../src/handlers/activity.ts";
import { handlers as home } from "../src/handlers/home.ts";
import { handlers as projects } from "../src/handlers/projects.ts";
import { contractApp, expectContract } from "./support/contract.ts";

type Row = Record<string, unknown>;
type DbError = { code: string; message: string; hint?: string | null };
type RpcResult = { data: unknown; error: DbError | null };

const ORG = "0192f1e2-7c3a-7b4d-9e8f-000000000001";
const ME = "0192f1e2-7c3a-7b4d-9e8f-00000000000a";
const PROJECT = "0192f1e2-7c3a-7b4d-9e8f-000000001001";
const NODE = "0192f1e2-7c3a-7b4d-9e8f-000000002001";
const T1 = "2026-10-01T12:00:00Z";

const base = (id: string, at = T1): Row => ({
  id,
  org_id: ORG,
  created_at: at,
  created_by: ME,
  updated_at: at,
  updated_by: ME,
  deleted_at: null,
});

function projectRow(over: Row = {}): Row {
  return {
    ...base(PROJECT),
    project_key: "NWS",
    name: "Northwind Summer Series",
    description: null,
    workspace_id: null,
    jurisdiction_id: "US-FL-MIAMI-DADE",
    region_code: "NA-SE-MIA",
    tier_code: "05",
    current_phase_code: "ENG",
    project_state: "Active",
    currency: "USD",
    starts_on: "2027-03-12",
    ends_on: "2027-03-15",
    ...over,
  };
}

/** Parses the keyset `or` filter grammar listPage emits: terms and `and(...)` groups. */
function orMatches(row: Row, filter: string): boolean {
  const split = (s: string) => {
    const out: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of s) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  };
  const term = (t: string): boolean => {
    if (t.startsWith("and(")) return split(t.slice(4, -1)).every(term);
    const [field, op, ...rest] = t.split(".");
    const raw = rest.join(".").replace(/^"|"$/g, "");
    const v = String(row[field as string]);
    if (op === "eq") return v === raw;
    if (op === "gt") return v > raw;
    if (op === "lt") return v < raw;
    return true;
  };
  return split(filter).some(term);
}

function memoryDb(
  tables: Record<string, Row[]>,
  rpcs: Record<string, (args: Row) => RpcResult> = {},
) {
  const query = (table: string) => {
    const state = {
      filters: [] as ((r: Row) => boolean)[],
      orders: [] as [string, boolean][],
      limit: undefined as number | undefined,
      columns: [] as [string, string][],
      patch: undefined as Row | undefined,
      head: false,
    };
    const run = () => {
      let rows = (tables[table] ?? []).filter((r) => state.filters.every((f) => f(r)));
      if (state.patch) {
        for (const r of rows) Object.assign(r, state.patch, { updated_at: "2026-10-02T09:00:00Z" });
      }
      for (const [col, asc] of [...state.orders].reverse()) {
        rows = [...rows].sort((a, b) => {
          const x = String(a[col]);
          const y = String(b[col]);
          return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
        });
      }
      if (state.limit !== undefined) rows = rows.slice(0, state.limit);
      const project = (r: Row) =>
        state.columns.length === 0
          ? r
          : Object.fromEntries(state.columns.map(([out, src]) => [out, r[src] ?? null]));
      return { rows: rows.map(project), count: rows.length };
    };
    const builder: Record<string, unknown> = {
      select(columns: string, opts?: { head?: boolean }) {
        state.columns = columns
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c !== "")
          .map((c) => {
            const [out, src] = c.includes(":") ? c.split(":") : [c, c];
            return [out as string, src as string];
          });
        state.head = opts?.head === true;
        return builder;
      },
      update(patch: Row) {
        state.patch = patch;
        return builder;
      },
      eq(c: string, v: unknown) {
        state.filters.push((r) => r[c] === v);
        return builder;
      },
      neq(c: string, v: unknown) {
        state.filters.push((r) => r[c] !== v);
        return builder;
      },
      is(c: string, v: unknown) {
        state.filters.push((r) => (r[c] ?? null) === v);
        return builder;
      },
      in(c: string, v: unknown[]) {
        state.filters.push((r) => v.includes(r[c]));
        return builder;
      },
      not(c: string, op: string, v: unknown) {
        if (op === "in") {
          const list = String(v).slice(1, -1).split(",");
          state.filters.push((r) => !list.includes(String(r[c])));
        } else if (op === "is") state.filters.push((r) => (r[c] ?? null) !== v);
        return builder;
      },
      or(filter: string) {
        state.filters.push((r) => orMatches(r, filter));
        return builder;
      },
      lt(c: string, v: string) {
        state.filters.push((r) => String(r[c]) < v);
        return builder;
      },
      lte(c: string, v: string) {
        state.filters.push((r) => String(r[c]) <= v);
        return builder;
      },
      gt(c: string, v: string) {
        state.filters.push((r) => String(r[c]) > v);
        return builder;
      },
      gte(c: string, v: string) {
        state.filters.push((r) => String(r[c]) >= v);
        return builder;
      },
      order(c: string, opts?: { ascending?: boolean }) {
        state.orders.push([c, opts?.ascending !== false]);
        return builder;
      },
      limit(n: number) {
        state.limit = n;
        return builder;
      },
      maybeSingle() {
        const { rows } = run();
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      single() {
        const { rows } = run();
        return Promise.resolve(
          rows[0]
            ? { data: rows[0], error: null }
            : { data: null, error: { code: "PGRST116", message: "no rows" } },
        );
      },
      then(resolve: (v: unknown) => void) {
        const { rows, count } = run();
        resolve(
          state.head ? { data: null, error: null, count } : { data: rows, error: null, count },
        );
      },
    };
    return builder;
  };
  const db = {
    from: (table: string) => query(table),
    schema: (name: string) => ({ from: (table: string) => query(`${name}.${table}`) }),
    rpc: (name: string, args: Row) => {
      const handler = rpcs[name];
      return Promise.resolve(
        handler
          ? handler(args)
          : { data: null, error: { code: "42883", message: `no rpc ${name}` } },
      );
    },
  };
  return db;
}

const PHASES: Row[] = ["SCP", "ENG", "ADV", "PRC", "BLD", "INS", "OPR", "AMP", "CLS"].map(
  (c, i) => ({
    phase_code: c,
    gate: i + 1,
    phase: c,
    act_code: "PLAN",
    definition: "d",
    gate_exit: "e",
  }),
);

function world(rpcs: Record<string, (args: Row) => RpcResult> = {}) {
  const tables: Record<string, Row[]> = {
    projects: [
      projectRow(),
      projectRow({
        ...base("0192f1e2-7c3a-7b4d-9e8f-000000001002", "2026-10-03T12:00:00Z"),
        project_key: "NWG",
        name: "Northwind Winter Gala",
        current_phase_code: "SCP",
        project_state: "Proposed",
      }),
    ],
    scope_nodes: [
      {
        ...base(NODE),
        project_id: PROJECT,
        parent_id: null,
        scope_code: "NWS-E01",
        name: "Northwind Summer Series",
        scope_kind: "Engagement Root",
        path: "NWS_E01",
      },
    ],
    project_phase_transitions: [
      {
        ...base("0192f1e2-7c3a-7b4d-9e8f-000000003001"),
        project_id: PROJECT,
        gate: 1,
        from_phase_code: "SCP",
        to_phase_code: "ENG",
        reason: "Go.",
      },
    ],
    gate_criteria_status: [
      {
        project_id: PROJECT,
        gate: 2,
        criterion_id: "G2.CONTRACTS",
        is_blocking: true,
        evidence_count: 1,
        best_assertion_rank: 4,
        gate_passed: false,
      },
      {
        project_id: PROJECT,
        gate: 2,
        criterion_id: "G2.ACCOUNTABLE_PARTY",
        is_blocking: true,
        evidence_count: 0,
        best_assertion_rank: null,
        gate_passed: false,
      },
      {
        project_id: PROJECT,
        gate: 1,
        criterion_id: "G1.GONOGO",
        is_blocking: true,
        evidence_count: 1,
        best_assertion_rank: 4,
        gate_passed: true,
      },
    ],
    "xpms.dim_phase": PHASES,
    "xpms.dim_gate_criterion": [
      { criterion_id: "G2.CONTRACTS", gate: 2, ordinal: 8, statement: "s", is_blocking: true },
      {
        criterion_id: "G2.ACCOUNTABLE_PARTY",
        gate: 2,
        ordinal: 9,
        statement: "s",
        is_blocking: true,
      },
    ],
    records: [
      {
        ...base("r1"),
        record_state: "Blocked",
        owner_party_id: ME,
        accountable_party_id: null,
        record_display_key: "NWS-1",
        title: "Hang Truss",
        record_kind: "Task",
        due_at: null,
        starts_at: null,
        ends_at: null,
        blocker_text: "Late",
        project: { project_key: "NWS" },
      },
      {
        ...base("r2"),
        record_state: "Active",
        owner_party_id: ME,
        accountable_party_id: null,
        record_display_key: "NWS-2",
        title: "Book Crew",
        record_kind: "Task",
        due_at: "2026-01-01T00:00:00Z",
        starts_at: null,
        ends_at: null,
        blocker_text: null,
        project: { project_key: "NWS" },
      },
    ],
    purchase_orders: [{ ...base("po1"), po_state: "Approved" }],
    purchase_order_totals: [
      {
        purchase_order_id: "po1",
        currency_code: "USD",
        lines_total_minor: 250_000,
        approved_changes_minor: null,
      },
    ],
  };
  const feed: Row = {
    id: "0192f1e2-7c3a-7b4d-9e8f-000000004001",
    occurred_at: "2026-10-05T10:00:00Z",
    event_type: "project.state_changed",
    subject_table: "projects",
    subject_id: PROJECT,
    project_id: PROJECT,
    project_key: "NWS",
    project_name: "Northwind Summer Series",
    actor_person_id: ME,
    actor_name: "Demo Producer",
    record_key: null,
    record_title: null,
    data: { from_state: "Proposed", to_state: "Active" },
    description: "A project moved to another project state.",
  };
  const db = memoryDb(tables, {
    resolve_settings: () => ({
      data: [{ setting_key: "org.base_currency", value_text: "USD" }],
      error: null,
    }),
    activity_feed: (args) => ({
      data: args["p_activity_id"] && args["p_activity_id"] !== feed["id"] ? [] : [feed],
      error: null,
    }),
    transition_project: () => {
      Object.assign((tables["projects"] as Row[])[0] ?? {}, { project_state: "Blocked" });
      return { data: "ledger", error: null };
    },
    pass_gate: () => ({
      data: null,
      error: {
        code: "XR001",
        message:
          "gate_criteria_unmet: Gate 2 needs evidence for every blocking criterion; missing: G2.ACCOUNTABLE_PARTY.",
        hint: "gate_criteria_unmet",
      },
    }),
    ...rpcs,
  });
  return { db, tables };
}

function api(db: unknown) {
  return contractApp({ handlers: [projects, home, activity], db, context: { personId: ME } });
}

const post = (body: unknown, extra: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID(), ...extra },
  body: JSON.stringify(body),
});
const patch = (body: unknown, ifMatch: string) => ({
  method: "PATCH",
  headers: { "content-type": "application/json", "if-match": ifMatch },
  body: JSON.stringify(body),
});

describe("projects", () => {
  it("lists projects in creation order and pages by cursor", async () => {
    const app = api(world().db);
    const first = (await expectContract(
      await app.request("/projects?limit=1"),
      "projects.list",
    )) as {
      data: Row[];
      next_cursor: string | null;
    };
    expect(first.data.map((p) => p["project_key"])).toEqual(["NWS"]);
    const second = (await expectContract(
      await app.request(`/projects?limit=1&cursor=${first.next_cursor}`),
      "projects.list",
    )) as { data: Row[]; next_cursor: string | null };
    expect(second.data.map((p) => p["project_key"])).toEqual(["NWG"]);
    expect(second.next_cursor).toBeNull();
  });

  it("gets a project with an ETag and answers 404 for one the caller cannot see", async () => {
    const app = api(world().db);
    const res = await app.request(`/projects/${PROJECT}`);
    expect(res.headers.get("etag")).toMatch(/^W\//);
    expect(await expectContract(res, "projects.get")).toMatchObject({
      project_key: "NWS",
      currency: "USD",
    });
    const missing = await app.request("/projects/0192f1e2-7c3a-7b4d-9e8f-0000000099ff");
    expect(missing.status).toBe(404);
    await expectContract(missing, "projects.get");
  });

  it("updates with If-Match and refuses a stale version", async () => {
    const app = api(world().db);
    const read = await app.request(`/projects/${PROJECT}`);
    const etag = read.headers.get("etag") as string;
    const res = await app.request(
      `/projects/${PROJECT}`,
      patch({ name: "Northwind Summer Series 2027" }, etag),
    );
    expect(await expectContract(res, "projects.update")).toMatchObject({
      name: "Northwind Summer Series 2027",
    });
    const stale = await app.request(`/projects/${PROJECT}`, patch({ name: "Again" }, etag));
    expect(stale.status).toBe(412);
    await expectContract(stale, "projects.update");
  });

  it("moves the project state and refuses a stale expected state", async () => {
    const app = api(world().db);
    const conflictRes = await app.request(
      `/projects/${PROJECT}/transitions`,
      post({ expected_state: "Proposed", to_state: "Active", reason: "Go." }),
    );
    expect(conflictRes.status).toBe(409);
    await expectContract(conflictRes, "projects.transition");
    const res = await app.request(
      `/projects/${PROJECT}/transitions`,
      post({ expected_state: "Active", to_state: "Blocked", reason: "Venue lost power." }),
    );
    expect(await expectContract(res, "projects.transition")).toMatchObject({
      project_state: "Blocked",
    });
  });

  it("refuses a gate pass with the missing criterion named (journey 2)", async () => {
    const app = api(world().db);
    const wrong = await app.request(
      `/projects/${PROJECT}/gate-transitions`,
      post({ expected_phase_code: "ENG", to_phase_code: "PRC" }),
    );
    expect(wrong.status).toBe(409);
    await expectContract(wrong, "projects.passGate");
    const refusedRes = await app.request(
      `/projects/${PROJECT}/gate-transitions`,
      post({ expected_phase_code: "ENG", to_phase_code: "ADV" }),
    );
    expect(refusedRes.status).toBe(422);
    const body = (await expectContract(refusedRes, "projects.passGate")) as Row;
    expect(body["rule"]).toBe("gate_criteria_unmet");
    expect(String(body["reason"])).toContain("G2.ACCOUNTABLE_PARTY");
  });

  it("passes a gate when the database accepts it", async () => {
    const { db, tables } = world({
      pass_gate: () => {
        Object.assign((tables["projects"] as Row[])[0] ?? {}, { current_phase_code: "ADV" });
        return { data: "ADV", error: null };
      },
    });
    const app = api(db);
    const res = await app.request(
      `/projects/${PROJECT}/gate-transitions`,
      post({ expected_phase_code: "ENG", to_phase_code: "ADV" }),
    );
    expect(await expectContract(res, "projects.passGate")).toMatchObject({
      current_phase_code: "ADV",
    });
  });

  it("reports readiness of the current gate", async () => {
    const app = api(world().db);
    const page = (await expectContract(
      await app.request(`/projects/${PROJECT}/gate-readiness`),
      "projects.gateReadiness",
    )) as { data: Row[] };
    expect(page.data).toEqual([
      {
        project_id: PROJECT,
        gate: 2,
        criterion_id: "G2.ACCOUNTABLE_PARTY",
        blocking: true,
        satisfied: false,
      },
      {
        project_id: PROJECT,
        gate: 2,
        criterion_id: "G2.CONTRACTS",
        blocking: true,
        satisfied: true,
      },
    ]);
  });

  it("answers 401 for an anonymous caller", async () => {
    const app = contractApp({ handlers: [projects], anonymous: true });
    const res = await app.request("/projects");
    expect(res.status).toBe(401);
    await expectContract(res, "projects.list");
  });
});

describe("scope nodes", () => {
  it("lists and gets nodes with the kind named as the contract does", async () => {
    const app = api(world().db);
    const page = (await expectContract(await app.request("/scope-nodes"), "scopeNodes.list")) as {
      data: Row[];
    };
    expect(page.data[0]).toMatchObject({ scope_code: "NWS-E01", node_kind: "Engagement Root" });
    expect(
      await expectContract(await app.request(`/scope-nodes/${NODE}`), "scopeNodes.get"),
    ).toMatchObject({
      node_kind: "Engagement Root",
    });
  });

  it("creates, renames and removes a node", async () => {
    const { db, tables } = world();
    const NEW = "0192f1e2-7c3a-7b4d-9e8f-000000002002";
    const real = db.from;
    db.from = (table: string) => {
      const b = real(table) as Record<string, (...a: unknown[]) => unknown>;
      if (table !== "scope_nodes") return b;
      const insert = (row: Row) => {
        (tables["scope_nodes"] as Row[]).push({ ...base(NEW), ...row, path: "NWS_E01.NWS_S01" });
        return {
          select: () => ({ single: () => Promise.resolve({ data: { id: NEW }, error: null }) }),
        };
      };
      return Object.assign(b, { insert });
    };
    const app = api(db);
    const createdRes = await app.request(
      "/scope-nodes",
      post({
        project_id: PROJECT,
        parent_id: NODE,
        scope_code: "NWS-S01",
        name: "Opening Night",
        node_kind: "Show",
      }),
    );
    expect(createdRes.status).toBe(201);
    expect(await expectContract(createdRes, "scopeNodes.create")).toMatchObject({
      node_kind: "Show",
    });
    const etag = (await app.request(`/scope-nodes/${NEW}`)).headers.get("etag") as string;
    const renamed = await app.request(
      `/scope-nodes/${NEW}`,
      patch({ name: "Opening Night Concert" }, etag),
    );
    expect(await expectContract(renamed, "scopeNodes.update")).toMatchObject({
      name: "Opening Night Concert",
    });
    const removed = await app.request(`/scope-nodes/${NEW}`, { method: "DELETE" });
    expect(removed.status).toBe(204);
    await expectContract(removed, "scopeNodes.delete");
  });
});

describe("gate history", () => {
  it("lists and gets gate transitions", async () => {
    const app = api(world().db);
    const page = (await expectContract(
      await app.request("/project-phase-transitions"),
      "projectPhaseTransitions.list",
    )) as { data: Row[] };
    expect(page.data[0]).toMatchObject({
      from_phase_code: "SCP",
      to_phase_code: "ENG",
      transitioned_at: T1,
    });
    const one = await app.request(
      "/project-phase-transitions/0192f1e2-7c3a-7b4d-9e8f-000000003001",
    );
    expect(await expectContract(one, "projectPhaseTransitions.get")).toMatchObject({
      transitioned_by: ME,
    });
    const missing = await app.request(
      "/project-phase-transitions/0192f1e2-7c3a-7b4d-9e8f-0000000039ff",
    );
    expect(missing.status).toBe(404);
    await expectContract(missing, "projectPhaseTransitions.get");
  });
});

describe("home", () => {
  it("summarizes work, risk, alerts and committed spend", async () => {
    const app = api(world().db);
    const body = await expectContract(await app.request("/home/summary"), "home.get");
    expect(body).toEqual({
      open_work_count: 2,
      blocked_work_count: 1,
      projects_at_risk_count: 1,
      alert_count: 2,
      committed_spend: { total_minor: 250_000, currency: "USD", unpriced_count: 0 },
    });
  });
});

describe("activity", () => {
  it("lists and gets feed entries", async () => {
    const app = api(world().db);
    const page = (await expectContract(
      await app.request("/activity-events"),
      "activityEvents.list",
    )) as {
      data: Row[];
      next_cursor: string | null;
    };
    expect(page.data[0]).toMatchObject({
      verb: "project.state_changed",
      subject_urn: `urn:xpms:projects:${PROJECT}`,
      summary: "A project moved to another project state.",
    });
    expect(page.next_cursor).toBeNull();
    const one = await app.request("/activity-events/0192f1e2-7c3a-7b4d-9e8f-000000004001");
    expect(await expectContract(one, "activityEvents.get")).toMatchObject({ actor_id: ME });
    const missing = await app.request("/activity-events/0192f1e2-7c3a-7b4d-9e8f-0000000049ff");
    expect(missing.status).toBe(404);
    await expectContract(missing, "activityEvents.get");
  });
});
