/**
 * A08 handlers (Schedule and Work) end to end through the runtime, against an in-memory stand-in
 * for the caller's Supabase client. Every response is checked against openapi/v1.json with
 * expectContract (Section 18, gate 5).
 */
import { describe, expect, it } from "vitest";
import { handlers as schedule } from "../src/handlers/schedule.ts";
import { dependencyCode, dependencyType, intervalMinutes } from "../src/handlers/schedule.ts";
import { handlers as work } from "../src/handlers/work.ts";
import { contractApp, expectContract } from "./support/contract.ts";

type Row = Record<string, unknown>;
type DbError = { code: string; message: string; hint?: string | null };
type RpcResult = { data: unknown; error: DbError | null };

const ORG = "0192f1e2-7c3a-7b4d-9e8f-000000000001";
const ME = "0192f1e2-7c3a-7b4d-9e8f-00000000000a";
const VENDOR = "0192f1e2-7c3a-7b4d-9e8f-000000000301";
const PROJECT = "0192f1e2-7c3a-7b4d-9e8f-000000001001";
const NODE = "0192f1e2-7c3a-7b4d-9e8f-000000002001";
const R1 = "0192f1e2-7c3a-7b4d-9e8f-000000005001";
const R2 = "0192f1e2-7c3a-7b4d-9e8f-000000005002";
const WO = "0192f1e2-7c3a-7b4d-9e8f-000000006001";
const BID = "0192f1e2-7c3a-7b4d-9e8f-000000006101";
const MISSING = "0192f1e2-7c3a-7b4d-9e8f-0000000099ff";
const T1 = "2026-10-01T12:00:00Z";

let serial = 0;
const newId = () => `0192f1e2-7c3a-7b4d-9e8f-${String(900000000000 + (serial += 1))}`;

const base = (id: string, at = T1): Row => ({
  id,
  org_id: ORG,
  created_at: at,
  created_by: ME,
  updated_at: at,
  updated_by: ME,
  deleted_at: null,
});

/** Splits a select list on top-level commas, keeping embedded resources whole. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function orMatches(row: Row, filter: string): boolean {
  const term = (t: string): boolean => {
    if (t.startsWith("and(")) return splitTop(t.slice(4, -1)).every(term);
    const [field, op, ...rest] = t.split(".");
    const raw = rest.join(".").replace(/^"|"$/g, "");
    const v = String(row[field as string]);
    if (op === "eq") return v === raw;
    if (op === "gt") return v > raw;
    if (op === "lt") return v < raw;
    return true;
  };
  return splitTop(filter).some(term);
}

/** Column defaults and computed fields the database fills on insert. */
const DEFAULTS: Record<string, Row> = {
  records: {
    record_state: "Proposed",
    record_class: "Work",
    record_number: 3,
    blocker_text: null,
    replan_reason: null,
  },
  work_orders: {
    work_order_state: "Draft",
    awarded_bid_id: null,
    scheduled_ends_at: null,
    work_order_number: 8,
    location_text: null,
    scope_of_work: null,
    scheduled_starts_at: null,
    estimated_hours: null,
  },
  work_order_bids: { withdrawn_at: null, work_order: { awarded_bid_id: null } },
};

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
      inserted: undefined as Row[] | undefined,
    };
    const run = () => {
      if (state.inserted) return state.inserted.map(project);
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
      return rows.map(project);
    };
    const project = (r: Row) =>
      state.columns.length === 0
        ? r
        : Object.fromEntries(state.columns.map(([out, src]) => [out, r[src] ?? null]));
    const builder: Record<string, unknown> = {
      select(columns: string) {
        state.columns = splitTop(columns).map((c) => {
          if (c === "*") return ["*", "*"];
          const embed = c.indexOf("(");
          const head = embed >= 0 ? c.slice(0, embed) : c;
          const [out, src] = head.includes(":") ? head.split(":") : [head, head];
          return embed >= 0
            ? [String(out).split("!")[0] as string, String(out).split("!")[0] as string]
            : [out as string, src as string];
        });
        if (state.columns.some(([c]) => c === "*")) state.columns = [];
        return builder;
      },
      insert(values: Row | Row[]) {
        const list = (Array.isArray(values) ? values : [values]).map((v) => {
          const row: Row = { ...base(newId()), ...(DEFAULTS[table] ?? {}), ...v };
          if (table === "records")
            row["record_display_key"] = `NWS-${(tables[table] ?? []).length + 1}`;
          return row;
        });
        (tables[table] ??= []).push(...list);
        state.inserted = list;
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
        if (op === "is") state.filters.push((r) => (r[c] ?? null) !== v);
        return builder;
      },
      or(filter: string) {
        state.filters.push((r) => orMatches(r, filter));
        return builder;
      },
      ilike(c: string, pattern: string) {
        const needle = pattern.replace(/^%|%$/g, "").toLowerCase();
        state.filters.push((r) => String(r[c]).toLowerCase().includes(needle));
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
        return Promise.resolve({ data: run()[0] ?? null, error: null });
      },
      single() {
        const rows = run();
        return Promise.resolve(
          rows[0]
            ? { data: rows[0], error: null }
            : { data: null, error: { code: "PGRST116", message: "no rows" } },
        );
      },
      then(resolve: (v: unknown) => void) {
        resolve({ data: run(), error: null });
      },
    };
    return builder;
  };
  return {
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
}

function recordRow(id: string, over: Row = {}): Row {
  return {
    ...base(id),
    project_id: PROJECT,
    record_number: id === R1 ? 1 : 2,
    record_display_key: id === R1 ? "NWS-1" : "NWS-2",
    record_kind: "Task",
    record_subtype: "Execute",
    record_class: "Work",
    record_state: "Proposed",
    title: "Hang the Truss",
    scope_node_id: NODE,
    phase_code: "BLD",
    urid: "5000.01.01",
    xyz: "X",
    owner_party_id: ME,
    accountable_party_id: null,
    starts_at: null,
    ends_at: null,
    due_at: "2027-03-12T18:00:00Z",
    time_zone: null,
    blocker_text: null,
    replan_reason: null,
    project: { project_key: "NWS", name: "Northwind Summer Series", time_zone: "America/New_York" },
    owner: { full_name: "Demo Producer" },
    ...over,
  };
}

const refusal = (rule: string, message: string): RpcResult => ({
  data: null,
  error: { code: "XR001", message: `${rule}: ${message}`, hint: rule },
});

function world(rpcs: Record<string, (args: Row) => RpcResult> = {}) {
  const tables: Record<string, Row[]> = {
    records: [
      recordRow(R1),
      recordRow(R2, { title: "Focus the Wash", created_at: "2026-10-02T12:00:00Z" }),
    ],
    scope_nodes: [{ ...base(NODE), project_id: PROJECT, name: "Northwind Summer Series" }],
    // records.list composes record_key from the project key (A24-010).
    projects: [{ ...base(PROJECT), project_key: "NWS" }],
    record_external_visibility: [
      {
        ...base(newId()),
        record_id: R1,
        external_role_type: "Vendor",
        person_id: null,
        organization_id: null,
      },
    ],
    "xpms.dim_category": [{ cat_urid: "5000.01.01", xyz: "X" }],
    record_task: [
      { record_id: R1, org_id: ORG, record_kind: "Task", progress_pct: 40, effort_hours: 6 },
    ],
    record_state_transitions: [
      {
        ...base(newId()),
        record_id: R1,
        from_state: null,
        to_state: "Proposed",
        reason: "Created.",
      },
      {
        ...base(newId(), "2026-10-01T13:00:00Z"),
        record_id: R1,
        from_state: "Proposed",
        to_state: "Ready",
        reason: "Accepted.",
      },
    ],
    record_checklist_items: [
      {
        ...base(newId()),
        record_id: R1,
        position: 1,
        label: "Check the safeties",
        checked_at: null,
        checked_by: null,
      },
    ],
    record_watchers: [{ ...base(newId()), record_id: R1, person_id: ME }],
    work_orders: [
      {
        ...base(WO),
        project_id: PROJECT,
        record_id: R1,
        title: "Rig the Main Stage Truss",
        urid: "5000.01.01",
        work_order_state: "Open",
        scheduled_ends_at: "2027-03-10T18:00:00Z",
        budget_minor: 900000,
        currency_code: "USD",
        awarded_bid_id: null,
        work_order_number: 7,
        location_text: "Main stage, stage left wing.",
        scope_of_work: null,
        scheduled_starts_at: null,
        estimated_hours: null,
      },
    ],
    work_order_bids: [
      {
        ...base(BID),
        work_order_id: WO,
        bidder_organization_id: VENDOR,
        bidder_person_id: null,
        amount_minor: 850000,
        currency_code: "USD",
        note: "Includes delivery.",
        withdrawn_at: null,
        work_order: { awarded_bid_id: null },
      },
    ],
    schedule_baselines: [
      {
        ...base(newId()),
        project_id: PROJECT,
        name: "Gate 3 Baseline",
        locked_at: "2026-10-01T13:00:00Z",
      },
      { ...base(newId()), project_id: PROJECT, name: "Draft", locked_at: null },
    ],
    schedule_actuals: [
      { ...base(newId()), record_id: R1, actual_starts_at: T1, actual_ends_at: null },
    ],
    calendars: [
      {
        ...base(newId()),
        project_id: PROJECT,
        name: "Venue Working Days",
        time_zone: "America/New_York",
      },
    ],
    record_dependencies: [
      {
        ...base(newId()),
        predecessor_record_id: R1,
        successor_record_id: R2,
        dependency_type: "Finish to Start",
        lag: "02:00:00",
      },
    ],
    record_recurrences: [
      {
        ...base(newId()),
        record_id: R1,
        rrule: "FREQ=WEEKLY;BYDAY=SA",
        time_zone: "America/New_York",
        until_at: null,
      },
    ],
  };
  const db = memoryDb(tables, {
    transition_record: (args) => {
      if (args["p_next"] === "Blocked" && !args["p_blocker_text"]) {
        return refusal("record_blocker_required", "A Blocked record names its blocker.");
      }
      const row = (tables["records"] as Row[]).find((r) => r["id"] === args["p_record_id"]);
      Object.assign(row ?? {}, {
        record_state: args["p_next"],
        blocker_text: args["p_blocker_text"] ?? null,
      });
      return { data: "entry", error: null };
    },
    transition_work_order: (args) => {
      if (args["p_next"] === "Awarded") {
        return refusal(
          "work_order_award_rpc_only",
          "A work order is awarded only through app.award_work_order.",
        );
      }
      Object.assign((tables["work_orders"] as Row[])[0] ?? {}, {
        work_order_state: args["p_next"],
      });
      return { data: "entry", error: null };
    },
    award_work_order: (args) => {
      const order = (tables["work_orders"] as Row[])[0] as Row;
      Object.assign(order, { work_order_state: "Awarded", awarded_bid_id: args["p_bid_id"] });
      for (const b of tables["work_order_bids"] as Row[])
        b["work_order"] = { awarded_bid_id: args["p_bid_id"] };
      return { data: "entry", error: null };
    },
    lock_baseline: (args) => {
      const row = (tables["schedule_baselines"] as Row[]).find(
        (b) => b["id"] === args["p_baseline_id"],
      );
      Object.assign(row ?? {}, { locked_at: "2026-10-03T08:00:00Z" });
      return { data: 2, error: null };
    },
    ...rpcs,
  });
  return { db, tables };
}

function api(db: unknown) {
  return contractApp({ handlers: [work, schedule], db, context: { personId: ME } });
}

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
  body: JSON.stringify(body),
});
const patch = (body: unknown, ifMatch: string) => ({
  method: "PATCH",
  headers: { "content-type": "application/json", "if-match": ifMatch },
  body: JSON.stringify(body),
});
const del = { method: "DELETE" };

async function etag(app: ReturnType<typeof api>, path: string) {
  return (await app.request(path)).headers.get("etag") as string;
}

describe("records", () => {
  it("lists records with keys and external visibility, paged by cursor", async () => {
    const app = api(world().db);
    const first = (await expectContract(await app.request("/records?limit=1"), "records.list")) as {
      data: Row[];
      next_cursor: string | null;
    };
    expect(first.data[0]).toMatchObject({ record_key: "NWS-1", external_visibility: ["Vendor"] });
    const second = (await expectContract(
      await app.request(`/records?limit=1&cursor=${first.next_cursor}`),
      "records.list",
    )) as { data: Row[]; next_cursor: string | null };
    expect(second.data[0]).toMatchObject({ record_key: "NWS-2", external_visibility: [] });
    expect(second.next_cursor).toBeNull();
    const sparse = (await expectContract(
      await app.request("/records?fields=title"),
      "records.list",
      {
        sparse: true,
      },
    )) as { data: Row[] };
    expect(Object.keys(sparse.data[0] ?? {}).sort()).toEqual(["id", "title"]);
  });

  it("gets a record and answers 404 for one the caller cannot see", async () => {
    const app = api(world().db);
    expect(await expectContract(await app.request(`/records/${R1}`), "records.get")).toMatchObject({
      record_class: "Work",
      title: "Hang the Truss",
    });
    const missing = await app.request(`/records/${MISSING}`);
    expect(missing.status).toBe(404);
    await expectContract(missing, "records.get");
  });

  it("creates a record under a scope node with its external visibility", async () => {
    const { db, tables } = world();
    const app = api(db);
    const res = await app.request(
      "/records",
      post({
        record_kind: "Task",
        title: "Label the Cable Runs",
        scope_node_id: NODE,
        phase_code: "BLD",
        urid: "5000.01.01",
        xyz: "X",
        external_visibility: ["Client"],
      }),
    );
    expect(res.status).toBe(201);
    const body = (await expectContract(res, "records.create")) as Row;
    expect(body["external_visibility"]).toEqual(["Client"]);
    expect((tables["records"] as Row[]).at(-1)).toMatchObject({
      xyz_basis: "Category",
      project_id: PROJECT,
    });
    const noNode = await app.request(
      "/records",
      post({
        record_kind: "Task",
        title: "x",
        scope_node_id: MISSING,
        phase_code: "BLD",
        xyz: "Y",
        external_visibility: [],
      }),
    );
    expect(noNode.status).toBe(422);
    await expectContract(noNode, "records.create");
    const blocked = await app.request(
      "/records",
      post({
        record_kind: "Task",
        title: "x",
        scope_node_id: NODE,
        phase_code: "BLD",
        xyz: "Y",
        external_visibility: [],
        blocker_text: "Late",
      }),
    );
    expect(blocked.status).toBe(400);
    await expectContract(blocked, "records.create");
  });

  it("updates with If-Match, recomputes the XYZ basis and replaces visibility", async () => {
    const { db, tables } = world();
    const app = api(db);
    const tag = await etag(app, `/records/${R1}`);
    const res = await app.request(
      `/records/${R1}`,
      patch({ title: "Hang the Upstage Truss", xyz: "Z", external_visibility: ["Client"] }, tag),
    );
    expect(await expectContract(res, "records.update")).toMatchObject({
      title: "Hang the Upstage Truss",
      external_visibility: ["Client"],
    });
    expect((tables["records"] as Row[])[0]).toMatchObject({ xyz_basis: "Declared" });
    const stale = await app.request(`/records/${R1}`, patch({ title: "Again" }, tag));
    expect(stale.status).toBe(412);
    await expectContract(stale, "records.update");
  });

  it("moves through states with compare-and-set and the database's refusals", async () => {
    const app = api(world().db);
    const stale = await app.request(
      `/records/${R1}/transitions`,
      post({ expected_state: "Active", to_state: "Blocked" }),
    );
    expect(stale.status).toBe(409);
    await expectContract(stale, "records.transition");
    const refusedRes = await app.request(
      `/records/${R1}/transitions`,
      post({ expected_state: "Proposed", to_state: "Blocked" }),
    );
    expect(refusedRes.status).toBe(422);
    expect(((await expectContract(refusedRes, "records.transition")) as Row)["rule"]).toBe(
      "record_blocker_required",
    );
    const res = await app.request(
      `/records/${R1}/transitions`,
      post({
        expected_state: "Proposed",
        to_state: "Blocked",
        blocker_text: "Waiting on the rigging plot.",
      }),
    );
    expect(await expectContract(res, "records.transition")).toMatchObject({
      record_state: "Blocked",
      blocker_text: "Waiting on the rigging plot.",
    });
  });

  it("duplicates a record with its checklist and trashes one", async () => {
    const { db, tables } = world();
    const app = api(db);
    const res = await app.request(`/records/${R1}/duplicate`, post({}));
    expect(res.status).toBe(201);
    await expectContract(res, "records.duplicate");
    expect(
      (tables["record_checklist_items"] as Row[]).filter(
        (i) => i["label"] === "Check the safeties",
      ),
    ).toHaveLength(2);
    expect((tables["record_task"] as Row[]).filter((t) => t["progress_pct"] === 40)).toHaveLength(
      2,
    );
    const gone = await app.request(`/records/${R2}`, del);
    expect(gone.status).toBe(204);
    await expectContract(gone, "records.delete");
    const again = await app.request(`/records/${R2}`, del);
    expect(again.status).toBe(404);
    await expectContract(again, "records.delete");
    const missing = await app.request(`/records/${MISSING}/duplicate`, post({}));
    expect(missing.status).toBe(404);
    await expectContract(missing, "records.duplicate");
  });

  it("reads the state ledger", async () => {
    const { db, tables } = world();
    const app = api(db);
    const page = (await expectContract(
      await app.request("/record-state-transitions"),
      "recordStateTransitions.list",
    )) as {
      data: Row[];
    };
    expect(page.data.map((t) => t["to_state"])).toEqual(["Ready"]);
    expect(page.data[0]).toMatchObject({ from_state: "Proposed", transitioned_by: ME });
    const id = String((tables["record_state_transitions"] as Row[])[1]?.["id"]);
    await expectContract(
      await app.request(`/record-state-transitions/${id}`),
      "recordStateTransitions.get",
    );
    const missing = await app.request(`/record-state-transitions/${MISSING}`);
    expect(missing.status).toBe(404);
    await expectContract(missing, "recordStateTransitions.get");
  });
});

describe("checklists and watchers", () => {
  it("lists, creates, ticks and removes checklist items", async () => {
    const { db, tables } = world();
    const app = api(db);
    const page = (await expectContract(
      await app.request("/record-checklist-items?filter[done][eq]=false"),
      "recordChecklistItems.list",
    )) as { data: Row[] };
    expect(page.data[0]).toMatchObject({ done: false, evidence_document_id: null });
    const done = (await expectContract(
      await app.request("/record-checklist-items?filter[done][eq]=true"),
      "recordChecklistItems.list",
    )) as { data: Row[] };
    expect(done.data).toEqual([]);
    const createdRes = await app.request(
      "/record-checklist-items",
      post({ record_id: R1, position: 2, label: "Tape the cables", done: true }),
    );
    expect(createdRes.status).toBe(201);
    const item = (await expectContract(createdRes, "recordChecklistItems.create")) as Row;
    expect(item["done"]).toBe(true);
    const first = String((tables["record_checklist_items"] as Row[])[0]?.["id"]);
    const tag = await etag(app, `/record-checklist-items/${first}`);
    const ticked = await app.request(
      `/record-checklist-items/${first}`,
      patch({ done: true }, tag),
    );
    expect(await expectContract(ticked, "recordChecklistItems.update")).toMatchObject({
      done: true,
    });
    const stale = await app.request(`/record-checklist-items/${first}`, patch({ label: "x" }, tag));
    expect(stale.status).toBe(412);
    await expectContract(stale, "recordChecklistItems.update");
    await expectContract(
      await app.request(`/record-checklist-items/${first}`),
      "recordChecklistItems.get",
    );
    const removed = await app.request(`/record-checklist-items/${first}`, del);
    expect(removed.status).toBe(204);
    await expectContract(removed, "recordChecklistItems.delete");
    const missing = await app.request(`/record-checklist-items/${first}`, del);
    expect(missing.status).toBe(404);
    await expectContract(missing, "recordChecklistItems.delete");
    const gone = await app.request(`/record-checklist-items/${first}`);
    expect(gone.status).toBe(404);
    await expectContract(gone, "recordChecklistItems.get");
  });

  it("watches and unwatches records", async () => {
    const { db, tables } = world();
    const app = api(db);
    await expectContract(await app.request("/record-watchers"), "recordWatchers.list");
    const res = await app.request("/record-watchers", post({ record_id: R2, person_id: ME }));
    expect(res.status).toBe(201);
    await expectContract(res, "recordWatchers.create");
    const id = String((tables["record_watchers"] as Row[])[0]?.["id"]);
    const removed = await app.request(`/record-watchers/${id}`, del);
    expect(removed.status).toBe(204);
    await expectContract(removed, "recordWatchers.delete");
    const missing = await app.request(`/record-watchers/${id}`, del);
    expect(missing.status).toBe(404);
    await expectContract(missing, "recordWatchers.delete");
  });
});

describe("work orders and bids", () => {
  it("lists, reads, creates, edits and deletes work orders", async () => {
    const { db } = world();
    const app = api(db);
    const page = (await expectContract(await app.request("/work-orders"), "workOrders.list")) as {
      data: Row[];
    };
    expect(page.data[0]).toMatchObject({
      due_at: "2027-03-10T18:00:00Z",
      budget_minor: 900000,
      currency: "USD",
    });
    await expectContract(await app.request(`/work-orders/${WO}`), "workOrders.get");
    const res = await app.request(
      "/work-orders",
      post({
        project_id: PROJECT,
        title: "Fabricate Bar Fascia",
        currency: "USD",
        budget_minor: null,
      }),
    );
    expect(res.status).toBe(201);
    const order = (await expectContract(res, "workOrders.create")) as Row;
    expect(order["budget_minor"]).toBeNull();
    const tag = await etag(app, `/work-orders/${WO}`);
    const edited = await app.request(`/work-orders/${WO}`, patch({ budget_minor: 950000 }, tag));
    expect(await expectContract(edited, "workOrders.update")).toMatchObject({
      budget_minor: 950000,
    });
    const stale = await app.request(`/work-orders/${WO}`, patch({ title: "x" }, tag));
    expect(stale.status).toBe(412);
    await expectContract(stale, "workOrders.update");
    const removed = await app.request(`/work-orders/${String(order["id"])}`, del);
    expect(removed.status).toBe(204);
    await expectContract(removed, "workOrders.delete");
    const missing = await app.request(`/work-orders/${MISSING}`);
    expect(missing.status).toBe(404);
    await expectContract(missing, "workOrders.get");
    const missingDelete = await app.request(`/work-orders/${MISSING}`, del);
    expect(missingDelete.status).toBe(404);
    await expectContract(missingDelete, "workOrders.delete");
  });

  it("moves work orders and refuses an award by transition", async () => {
    const app = api(world().db);
    const stale = await app.request(
      `/work-orders/${WO}/transitions`,
      post({ expected_state: "Draft", to_state: "Open" }),
    );
    expect(stale.status).toBe(409);
    await expectContract(stale, "workOrders.transition");
    const refusedRes = await app.request(
      `/work-orders/${WO}/transitions`,
      post({ expected_state: "Open", to_state: "Awarded" }),
    );
    expect(refusedRes.status).toBe(422);
    await expectContract(refusedRes, "workOrders.transition");
    const res = await app.request(
      `/work-orders/${WO}/transitions`,
      post({ expected_state: "Open", to_state: "Canceled", reason: "Scope moved in house." }),
    );
    expect(await expectContract(res, "workOrders.transition")).toMatchObject({
      work_order_state: "Canceled",
    });
  });

  it("records, edits and awards bids", async () => {
    const { db } = world();
    const app = api(db);
    const page = (await expectContract(
      await app.request("/work-order-bids"),
      "workOrderBids.list",
    )) as { data: Row[] };
    expect(page.data[0]).toMatchObject({
      bid_state: "Submitted",
      notes: "Includes delivery.",
      currency: "USD",
    });
    const res = await app.request(
      "/work-order-bids",
      post({ work_order_id: WO, bidder_organization_id: VENDOR, currency: "USD" }),
    );
    expect(res.status).toBe(201);
    expect(await expectContract(res, "workOrderBids.create")).toMatchObject({ amount_minor: null });
    const tag = await etag(app, `/work-order-bids/${BID}`);
    const edited = await app.request(
      `/work-order-bids/${BID}`,
      patch({ amount_minor: 800000 }, tag),
    );
    expect(await expectContract(edited, "workOrderBids.update")).toMatchObject({
      amount_minor: 800000,
    });
    const stale = await app.request(`/work-order-bids/${BID}`, patch({ notes: "x" }, tag));
    expect(stale.status).toBe(412);
    await expectContract(stale, "workOrderBids.update");
    const awarded = await app.request(`/work-order-bids/${BID}/award`, post({}));
    expect(await expectContract(awarded, "workOrderBids.award")).toMatchObject({
      bid_state: "Awarded",
    });
    await expectContract(await app.request(`/work-order-bids/${BID}`), "workOrderBids.get");
    const missing = await app.request(`/work-order-bids/${MISSING}`);
    expect(missing.status).toBe(404);
    await expectContract(missing, "workOrderBids.get");
  });

  it("answers the award refusal for the work order's creator", async () => {
    const app = api(
      world({
        award_work_order: () =>
          refusal(
            "sod_work_order_award",
            "A work order is awarded by someone other than the person who created it.",
          ),
      }).db,
    );
    const res = await app.request(`/work-order-bids/${BID}/award`, post({}));
    expect(res.status).toBe(422);
    expect(((await expectContract(res, "workOrderBids.award")) as Row)["rule"]).toBe(
      "sod_work_order_award",
    );
  });
});

describe("schedule", () => {
  it("lists captured baselines and captures one on create", async () => {
    const { db, tables } = world();
    const app = api(db);
    const page = (await expectContract(
      await app.request("/schedule-baselines"),
      "scheduleBaselines.list",
    )) as {
      data: Row[];
    };
    expect(page.data.map((b) => b["name"])).toEqual(["Gate 3 Baseline"]);
    const res = await app.request(
      "/schedule-baselines",
      post({ project_id: PROJECT, name: "Load-In Baseline" }),
    );
    expect(res.status).toBe(201);
    const body = (await expectContract(res, "scheduleBaselines.create")) as Row;
    expect(body["captured_at"]).toBe("2026-10-03T08:00:00Z");
    await expectContract(
      await app.request(`/schedule-baselines/${String(body["id"])}`),
      "scheduleBaselines.get",
    );
    const draft = String((tables["schedule_baselines"] as Row[])[1]?.["id"]);
    const removed = await app.request(`/schedule-baselines/${draft}`, del);
    expect(removed.status).toBe(204);
    await expectContract(removed, "scheduleBaselines.delete");
    const missing = await app.request(`/schedule-baselines/${MISSING}`);
    expect(missing.status).toBe(404);
    await expectContract(missing, "scheduleBaselines.get");
  });

  it("answers the lock refusal when capture fails", async () => {
    const app = api(
      world({ lock_baseline: () => refusal("baseline_locked", "This baseline is already locked.") })
        .db,
    );
    const res = await app.request(
      "/schedule-baselines",
      post({ project_id: PROJECT, name: "Again" }),
    );
    expect(res.status).toBe(422);
    await expectContract(res, "scheduleBaselines.create");
  });

  it("records actuals", async () => {
    const { db, tables } = world();
    const app = api(db);
    const page = (await expectContract(
      await app.request("/schedule-actuals"),
      "scheduleActuals.list",
    )) as { data: Row[] };
    expect(page.data[0]).toMatchObject({ actual_start_at: T1, actual_end_at: null });
    const res = await app.request(
      "/schedule-actuals",
      post({ record_id: R2, actual_start_at: T1 }),
    );
    expect(res.status).toBe(201);
    await expectContract(res, "scheduleActuals.create");
    const id = String((tables["schedule_actuals"] as Row[])[0]?.["id"]);
    await expectContract(await app.request(`/schedule-actuals/${id}`), "scheduleActuals.get");
    const tag = await etag(app, `/schedule-actuals/${id}`);
    const edited = await app.request(
      `/schedule-actuals/${id}`,
      patch({ actual_end_at: "2026-10-01T20:00:00Z" }, tag),
    );
    expect(await expectContract(edited, "scheduleActuals.update")).toMatchObject({
      actual_end_at: "2026-10-01T20:00:00Z",
    });
    const stale = await app.request(`/schedule-actuals/${id}`, patch({ actual_end_at: null }, tag));
    expect(stale.status).toBe(412);
    await expectContract(stale, "scheduleActuals.update");
  });

  it("keeps working calendars", async () => {
    const { db, tables } = world();
    const app = api(db);
    await expectContract(await app.request("/calendars"), "calendars.list");
    const res = await app.request(
      "/calendars",
      post({ name: "Show Days", time_zone: "America/New_York", project_id: PROJECT }),
    );
    expect(res.status).toBe(201);
    await expectContract(res, "calendars.create");
    const id = String((tables["calendars"] as Row[])[0]?.["id"]);
    await expectContract(await app.request(`/calendars/${id}`), "calendars.get");
    const tag = await etag(app, `/calendars/${id}`);
    const edited = await app.request(`/calendars/${id}`, patch({ name: "Venue Days" }, tag));
    expect(await expectContract(edited, "calendars.update")).toMatchObject({ name: "Venue Days" });
    const removed = await app.request(`/calendars/${id}`, del);
    expect(removed.status).toBe(204);
    await expectContract(removed, "calendars.delete");
    const missing = await app.request(`/calendars/${id}`);
    expect(missing.status).toBe(404);
    await expectContract(missing, "calendars.get");
  });

  it("codes dependencies and their lag as the contract does", async () => {
    expect(dependencyCode("Start to Finish")).toBe("start_to_finish");
    expect(dependencyType("finish_to_start")).toBe("Finish to Start");
    expect(intervalMinutes("-01:30:00")).toBe(-90);
    expect(intervalMinutes("1 day 00:10:00")).toBe(1450);
    expect(intervalMinutes("15")).toBe(15);
    const { db, tables } = world();
    const app = api(db);
    const page = (await expectContract(
      await app.request("/record-dependencies"),
      "recordDependencies.list",
    )) as {
      data: Row[];
    };
    expect(page.data[0]).toMatchObject({
      predecessor_id: R1,
      successor_id: R2,
      dependency_type: "finish_to_start",
      lag_minutes: 120,
    });
    const res = await app.request(
      "/record-dependencies",
      post({
        predecessor_id: R2,
        successor_id: R1,
        dependency_type: "start_to_start",
        lag_minutes: -30,
      }),
    );
    expect(res.status).toBe(201);
    await expectContract(res, "recordDependencies.create");
    expect((tables["record_dependencies"] as Row[]).at(-1)).toMatchObject({
      dependency_type: "Start to Start",
      lag: "-30 minutes",
    });
    const id = String((tables["record_dependencies"] as Row[])[0]?.["id"]);
    await expectContract(await app.request(`/record-dependencies/${id}`), "recordDependencies.get");
    const removed = await app.request(`/record-dependencies/${id}`, del);
    expect(removed.status).toBe(204);
    await expectContract(removed, "recordDependencies.delete");
    const missing = await app.request(`/record-dependencies/${id}`);
    expect(missing.status).toBe(404);
    await expectContract(missing, "recordDependencies.get");
  });

  it("keeps recurrence rules with their last day", async () => {
    const { db, tables } = world();
    const app = api(db);
    const page = (await expectContract(
      await app.request("/record-recurrences?filter[until][is_null]=true"),
      "recordRecurrences.list",
    )) as { data: Row[] };
    expect(page.data[0]).toMatchObject({ rrule: "FREQ=WEEKLY;BYDAY=SA", until: null });
    const res = await app.request(
      "/record-recurrences",
      post({
        record_id: R2,
        rrule: "FREQ=DAILY",
        time_zone: "America/New_York",
        until: "2027-03-15",
      }),
    );
    expect(res.status).toBe(201);
    expect(await expectContract(res, "recordRecurrences.create")).toMatchObject({
      until: "2027-03-15",
    });
    const id = String((tables["record_recurrences"] as Row[])[0]?.["id"]);
    await expectContract(await app.request(`/record-recurrences/${id}`), "recordRecurrences.get");
    const tag = await etag(app, `/record-recurrences/${id}`);
    const edited = await app.request(
      `/record-recurrences/${id}`,
      patch({ until: null, rrule: "FREQ=WEEKLY;BYDAY=SU" }, tag),
    );
    expect(await expectContract(edited, "recordRecurrences.update")).toMatchObject({
      rrule: "FREQ=WEEKLY;BYDAY=SU",
    });
    const removed = await app.request(`/record-recurrences/${id}`, del);
    expect(removed.status).toBe(204);
    await expectContract(removed, "recordRecurrences.delete");
    const missing = await app.request(`/record-recurrences/${id}`, del);
    expect(missing.status).toBe(404);
    await expectContract(missing, "recordRecurrences.delete");
  });
});
