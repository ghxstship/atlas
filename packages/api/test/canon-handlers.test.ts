/**
 * The exemplar Canon handlers end to end through the runtime, against an in-memory query
 * builder that behaves like supabase-js for the calls they make.
 */
import { describe, expect, it } from "vitest";
import type { XosClient } from "@xos/data";
import { createApiApp } from "../src/app.ts";
import type { RequestContext } from "../src/runtime/context.ts";
import {
  decodeCursor,
  encodeCursor,
  pageSize,
  selectColumns,
  toPage,
} from "../src/runtime/pagination.ts";

type Row = Record<string, string | null>;

const DEPARTMENTS: Row[] = ["0000", "1000", "2000", "3000", "4000"].map((code) => ({
  dept_code: code,
  department: `Department ${code}`,
  source: "canon",
  note: null,
}));

function fakeDb(rows: Row[], fail?: { code: string; message: string }): XosClient {
  const builder = (state: { rows: Row[]; columns: string[]; limit?: number }) => {
    const self = {
      select: (columns: string) => builder({ ...state, columns: columns.split(",") }),
      order: (column: string) =>
        builder({
          ...state,
          rows: [...state.rows].sort((a, b) => String(a[column]).localeCompare(String(b[column]))),
        }),
      limit: (n: number) => builder({ ...state, limit: n }),
      gt: (column: string, value: string) =>
        builder({ ...state, rows: state.rows.filter((r) => String(r[column]) > value) }),
      eq: (column: string, value: string) =>
        builder({ ...state, rows: state.rows.filter((r) => r[column] === value) }),
      maybeSingle: () => {
        const row = state.rows[0];
        return Promise.resolve(
          fail
            ? { data: null, error: fail }
            : { data: row === undefined ? null : project(row, state.columns), error: null },
        );
      },
      then: (resolve: (v: unknown) => void) =>
        resolve(
          fail
            ? { data: null, error: fail }
            : {
                data: state.rows.slice(0, state.limit).map((r) => project(r, state.columns)),
                error: null,
              },
        ),
    };
    return self;
  };
  const project = (row: Row, columns: string[]) =>
    Object.fromEntries(columns.map((c) => [c, row[c] ?? null]));
  const from = () => builder({ rows, columns: [] });
  return { schema: () => ({ from }) } as unknown as XosClient;
}

function app(db: XosClient) {
  const context: RequestContext = {
    user: { id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f", email: null },
    personId: null,
    org: null,
    locale: "en-US",
    db,
    credential: "session",
    requestId: "req-1",
  };
  return createApiApp({ authenticate: async () => context, validateResponses: true });
}

describe("canonDepartments", () => {
  it("pages in numeric code order with a cursor", async () => {
    const api = app(fakeDb(DEPARTMENTS));
    const first = await api.request("/canon/departments?limit=2");
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as { data: Row[]; next_cursor: string };
    expect(page1.data.map((r) => r["dept_code"])).toEqual(["0000", "1000"]);
    const second = await api.request(`/canon/departments?limit=2&cursor=${page1.next_cursor}`);
    const page2 = (await second.json()) as { data: Row[]; next_cursor: string };
    expect(page2.data.map((r) => r["dept_code"])).toEqual(["2000", "3000"]);
    const third = await api.request(`/canon/departments?limit=2&cursor=${page2.next_cursor}`);
    const page3 = (await third.json()) as { data: Row[]; next_cursor: string | null };
    expect(page3.data.map((r) => r["dept_code"])).toEqual(["4000"]);
    expect(page3.next_cursor).toBeNull();
  });

  it("gets one department and answers 404 for a missing code", async () => {
    const api = app(fakeDb(DEPARTMENTS));
    const res = await api.request("/canon/departments/4000");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DEPARTMENTS[4]);
    const missing = await api.request("/canon/departments/9000");
    expect(missing.status).toBe(404);
  });

  it("refuses a damaged cursor and unknown fields", async () => {
    const api = app(fakeDb(DEPARTMENTS));
    expect((await api.request("/canon/departments?cursor=xyz")).status).toBe(400);
    expect((await api.request("/canon/departments?fields=nope")).status).toBe(400);
  });

  it("maps a privilege error to 404", async () => {
    const api = app(fakeDb(DEPARTMENTS, { code: "42501", message: "permission denied" }));
    expect((await api.request("/canon/departments/4000")).status).toBe(404);
    expect((await api.request("/canon/departments")).status).toBe(404);
  });
});

describe("pagination helpers", () => {
  it("round-trips cursors and checks their keys", () => {
    const token = encodeCursor({ id: "a", n: 1 });
    expect(decodeCursor(token, ["id", "n"])).toEqual({ id: "a", n: 1 });
    expect(() => decodeCursor(token, ["id"])).toThrow();
    expect(() => decodeCursor(encodeCursor({ id: { x: 1 } } as never), ["id"])).toThrow();
    expect(() => decodeCursor(Buffer.from("[1]").toString("base64url"), ["id"])).toThrow();
  });

  it("clamps the page size", () => {
    expect(pageSize(undefined)).toBe(50);
    expect(pageSize(500)).toBe(200);
    expect(pageSize(0)).toBe(1);
  });

  it("builds pages and sparse column lists", () => {
    expect(toPage([1, 2, 3], 2, (n) => ({ n })).next_cursor).not.toBeNull();
    expect(toPage([1, 2], 2, (n) => ({ n })).next_cursor).toBeNull();
    expect(selectColumns("title", ["id", "title", "state"], "id")).toEqual(["id", "title"]);
    expect(selectColumns(undefined, ["id", "title"], "id")).toEqual(["id", "title"]);
  });
});
