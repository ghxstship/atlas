/**
 * An in-memory stand-in for the caller's supabase-js client (A04P contract tests). It holds rows by
 * table, answers the query builder calls the handlers make (select with `field:column` aliases,
 * insert, update, delete, filters, the keyset `or`, order and limit) and runs registered RPCs. A
 * queued error answers the next call on a table or RPC, as a refusal or RLS denial would.
 */
export type Row = Record<string, unknown>;
export type DbError = { code: string; message: string; hint?: string | null; details?: string };
export type Rpc = (args: Row, db: MemoryDb) => unknown;

let counter = 0;

/** A fresh UUIDv7-shaped id, unique within the test run. */
export function newId(): string {
  counter += 1;
  return `0192f1e2-7c3a-7b4d-9e8f-${(0xa00000000000 + counter).toString(16)}`;
}

function split(s: string): string[] {
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
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = a === null || a === undefined ? "" : String(a);
  const y = b === null || b === undefined ? "" : String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Evaluates the keyset `or` filter grammar listPage emits: terms and `and(...)` groups. */
function orMatches(row: Row, filter: string): boolean {
  const term = (t: string): boolean => {
    if (t.startsWith("and(")) return split(t.slice(4, -1)).every(term);
    const [field, op, ...rest] = t.split(".");
    const raw = rest.join(".").replace(/^"|"$/g, "");
    const value = row[field as string];
    const c = compare(typeof value === "number" ? value : String(value ?? ""), raw);
    if (op === "eq") return String(value ?? "null") === raw;
    if (op === "gt") return c > 0;
    if (op === "lt") return c < 0;
    if (op === "gte") return c >= 0;
    if (op === "lte") return c <= 0;
    return false;
  };
  return split(filter).some(term);
}

export interface MemoryDb {
  readonly tables: Record<string, Row[]>;
  /** Every insert, update and delete, in order. */
  readonly writes: { table: string; op: string; values: unknown }[];
  /** Every RPC call, in order. */
  readonly calls: { name: string; args: Row }[];
  /** Answers the next call on `target` (`table`, `schema.table` or `rpc:name`) with `error`. */
  fail(target: string, error: DbError): void;
  from(table: string): unknown;
  schema(name: string): { from(table: string): unknown };
  rpc(name: string, args?: Row): unknown;
}

const DEFAULT_TIME = "2026-10-01T12:00:00.000Z";

export function memoryDb(
  tables: Record<string, Row[]> = {},
  rpcs: Record<string, Rpc> = {},
  /** Column defaults by table, as the database fills them on insert. */
  defaults: Record<string, Row> = {},
): MemoryDb {
  const failures = new Map<string, DbError[]>();
  const takeFailure = (target: string) => failures.get(target)?.shift();
  const db: MemoryDb = {
    tables,
    writes: [],
    calls: [],
    fail(target, error) {
      failures.set(target, [...(failures.get(target) ?? []), error]);
    },
    from: (table: string) => query("app", table),
    schema: (name: string) => ({ from: (table: string) => query(name, table) }),
    rpc(name: string, args: Row = {}) {
      db.calls.push({ name, args });
      const failure = takeFailure(`rpc:${name}`);
      const run = (): { data: unknown; error: DbError | null } => {
        if (failure) return { data: null, error: failure };
        const fn = rpcs[name];
        if (fn === undefined) {
          return { data: null, error: { code: "PGRST202", message: `no rpc ${name}` } };
        }
        try {
          return { data: fn(args, db) ?? null, error: null };
        } catch (e) {
          return { data: null, error: e as DbError };
        }
      };
      const result = run();
      const thenable = {
        then: (resolve: (v: unknown) => void) => resolve(result),
        single: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve(result),
        select: () => thenable,
      };
      return thenable;
    },
  };

  function rowsOf(schema: string, table: string): Row[] {
    const name = schema === "app" ? table : `${schema}.${table}`;
    tables[name] ??= [];
    return tables[name] as Row[];
  }

  function query(schema: string, table: string) {
    const name = schema === "app" ? table : `${schema}.${table}`;
    const failure = takeFailure(name);
    const state = {
      filters: [] as ((r: Row) => boolean)[],
      orders: [] as [string, boolean][],
      limit: undefined as number | undefined,
      columns: undefined as [string, string][] | undefined,
      op: "select" as "select" | "insert" | "update" | "delete",
      values: undefined as Row | Row[] | undefined,
      head: false,
      count: false,
    };
    const project = (r: Row) =>
      state.columns === undefined
        ? { ...r }
        : Object.fromEntries(state.columns.map(([out, src]) => [out, r[src] ?? null]));
    const execute = (): { data: Row[] | null; error: DbError | null; count?: number } => {
      if (failure) return { data: null, error: failure };
      const all = rowsOf(schema, table);
      if (state.op === "insert") {
        const list = Array.isArray(state.values) ? state.values : [state.values as Row];
        const added = list.map((v) => ({
          id: newId(),
          created_at: DEFAULT_TIME,
          updated_at: DEFAULT_TIME,
          created_by: null,
          updated_by: null,
          deleted_at: null,
          ...defaults[name],
          ...v,
        }));
        all.push(...added);
        db.writes.push({ table: name, op: "insert", values: state.values });
        return { data: state.columns === undefined ? null : added.map(project), error: null };
      }
      let rows = all.filter((r) => state.filters.every((f) => f(r)));
      if (state.op === "update") {
        db.writes.push({ table: name, op: "update", values: state.values });
        for (const r of rows) {
          Object.assign(r, state.values, { updated_at: "2026-10-02T09:00:00.000Z" });
        }
        return { data: state.columns === undefined ? null : rows.map(project), error: null };
      }
      if (state.op === "delete") {
        db.writes.push({ table: name, op: "delete", values: rows.map((r) => r["id"]) });
        for (const r of rows) all.splice(all.indexOf(r), 1);
        return { data: state.columns === undefined ? null : rows.map(project), error: null };
      }
      for (const [col, asc] of [...state.orders].reverse()) {
        rows = [...rows].sort((a, b) => compare(a[col], b[col]) * (asc ? 1 : -1));
      }
      const count = rows.length;
      if (state.limit !== undefined) rows = rows.slice(0, state.limit);
      return { data: state.head ? null : rows.map(project), error: null, count };
    };
    const builder: Record<string, unknown> = {
      select(columns: string, opts?: { head?: boolean; count?: string }) {
        state.columns = split(columns)
          .map((c) => c.trim())
          .filter((c) => c !== "" && !c.includes("("))
          .map((c) => {
            const [out, src] = c.includes(":") ? c.split(":") : [c, c];
            return [(out as string).trim(), (src as string).trim()];
          });
        state.head = opts?.head === true;
        state.count = opts?.count !== undefined;
        return builder;
      },
      insert(values: Row | Row[]) {
        state.op = "insert";
        state.values = values;
        return builder;
      },
      upsert(values: Row | Row[]) {
        state.op = "insert";
        state.values = values;
        return builder;
      },
      update(values: Row) {
        state.op = "update";
        state.values = values;
        return builder;
      },
      delete() {
        state.op = "delete";
        return builder;
      },
      eq(c: string, v: unknown) {
        state.filters.push((r) => String(r[c]) === String(v));
        return builder;
      },
      neq(c: string, v: unknown) {
        state.filters.push((r) => String(r[c]) !== String(v));
        return builder;
      },
      is(c: string, v: unknown) {
        state.filters.push((r) => (r[c] ?? null) === v);
        return builder;
      },
      in(c: string, v: unknown[]) {
        state.filters.push((r) => v.map(String).includes(String(r[c])));
        return builder;
      },
      not(c: string, op: string, v: unknown) {
        if (op === "is") state.filters.push((r) => (r[c] ?? null) !== v);
        else if (op === "in") {
          const list = String(v).slice(1, -1).split(",");
          state.filters.push((r) => !list.includes(String(r[c])));
        }
        return builder;
      },
      or(filter: string) {
        state.filters.push((r) => orMatches(r, filter));
        return builder;
      },
      gt(c: string, v: unknown) {
        state.filters.push((r) => compare(r[c], v) > 0);
        return builder;
      },
      gte(c: string, v: unknown) {
        state.filters.push((r) => compare(r[c], v) >= 0);
        return builder;
      },
      lt(c: string, v: unknown) {
        state.filters.push((r) => compare(r[c], v) < 0);
        return builder;
      },
      lte(c: string, v: unknown) {
        state.filters.push((r) => compare(r[c], v) <= 0);
        return builder;
      },
      ilike(c: string, pattern: string) {
        const needle = pattern.replace(/^%|%$/g, "").replace(/\\(.)/g, "$1").toLowerCase();
        state.filters.push((r) =>
          String(r[c] ?? "")
            .toLowerCase()
            .includes(needle),
        );
        return builder;
      },
      contains(c: string, v: unknown[]) {
        state.filters.push((r) => {
          const have = (r[c] ?? []) as unknown[];
          return v.every((x) => have.includes(x));
        });
        return builder;
      },
      overlaps(c: string, v: unknown[]) {
        state.filters.push((r) => ((r[c] ?? []) as unknown[]).some((x) => v.includes(x)));
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
      range(from: number, to: number) {
        state.limit = to + 1;
        void from;
        return builder;
      },
      maybeSingle() {
        const { data, error } = execute();
        return Promise.resolve({ data: data?.[0] ?? null, error });
      },
      single() {
        const { data, error } = execute();
        if (error) return Promise.resolve({ data: null, error });
        return Promise.resolve(
          data?.[0]
            ? { data: data[0], error: null }
            : { data: null, error: { code: "PGRST116", message: "no rows" } },
        );
      },
      then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
        try {
          resolve(execute());
        } catch (e) {
          reject?.(e);
        }
      },
    };
    return builder;
  }

  return db;
}

/** The audit columns of a tenant row. */
export function tenantRow(id: string, org: string, extra: Row = {}): Row {
  return {
    id,
    org_id: org,
    created_at: DEFAULT_TIME,
    created_by: null,
    updated_at: DEFAULT_TIME,
    updated_by: null,
    deleted_at: null,
    ...extra,
  };
}

/** The base columns of a global row. */
export function globalRow(id: string, extra: Row = {}): Row {
  return {
    id,
    created_at: DEFAULT_TIME,
    updated_at: DEFAULT_TIME,
    deleted_at: null,
    ...extra,
  };
}

/** An XR001 refusal as Postgres raises it. */
export function refusal(rule: string, sentence = "The rule refused the change."): DbError {
  return { code: "XR001", message: `${rule}: ${sentence}`, hint: rule };
}

let keys = 1000;
let current: Requester | undefined;

/** Throws with the problem body unless the response is a success; returns it for expectContract. */
export async function success(response: Response | Promise<Response>): Promise<Response> {
  const r = await response;
  if (r.status >= 200 && r.status < 300) return r;
  const errors = (current as { errors?: unknown[] } | undefined)?.errors ?? [];
  throw new Error(
    `Expected a success, got ${r.status}: ${await r.text()} ${errors.map((e) => (e instanceof Error ? e.stack : JSON.stringify(e))).join("; ")}`,
  );
}

type Requester = { request(path: string, init?: RequestInit): Response | Promise<Response> };

/** Request helpers for a contract app: POST with an Idempotency-Key, PATCH with If-Match. */
export function requests(app: Requester) {
  current = app;
  const json = { "content-type": "application/json" };
  return {
    get: (path: string) => Promise.resolve(app.request(path)),
    post: (path: string, body?: unknown) => {
      keys += 1;
      return Promise.resolve(
        app.request(path, {
          method: "POST",
          headers: { ...json, "idempotency-key": `a04p-key-${keys}` },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    },
    patch: (path: string, body: unknown, ifMatch = "*") =>
      Promise.resolve(
        app.request(path, {
          method: "PATCH",
          headers: { ...json, "if-match": ifMatch },
          body: JSON.stringify(body),
        }),
      ),
    delete: (path: string) => Promise.resolve(app.request(path, { method: "DELETE" })),
  };
}
