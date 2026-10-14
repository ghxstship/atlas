/**
 * The exemplar Canon handlers end to end through the runtime, against an in-memory query
 * builder that behaves like supabase-js for the calls they make.
 */
import { describe, expect, it } from "vitest";
import type { XosClient } from "@xos/data";
import { handlers } from "../src/handlers/canon.ts";
import { contractApp, expectContract, validateSchema } from "./support/contract.ts";
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
      // The keyset filter of a single-key order: `column.gt.value`.
      or: (filter: string) => {
        const [column, , value] = filter.split(".");
        return builder({
          ...state,
          rows: state.rows.filter((r) => String(r[column as string]) > String(value)),
        });
      },
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
  return contractApp({ handlers: [handlers], db, context: { org: null, personId: null } });
}

describe("canonDepartments", () => {
  it("pages in numeric code order with a cursor", async () => {
    const api = app(fakeDb(DEPARTMENTS));
    const first = await api.request("/canon/departments?limit=2");
    const page1 = (await expectContract(first, "canonDepartments.list")) as {
      data: Row[];
      next_cursor: string;
    };
    expect(page1.data.map((r) => r["dept_code"])).toEqual(["0000", "1000"]);
    const second = await api.request(`/canon/departments?limit=2&cursor=${page1.next_cursor}`);
    const page2 = (await expectContract(second, "canonDepartments.list")) as {
      data: Row[];
      next_cursor: string;
    };
    expect(page2.data.map((r) => r["dept_code"])).toEqual(["2000", "3000"]);
    const third = await api.request(`/canon/departments?limit=2&cursor=${page2.next_cursor}`);
    const page3 = (await expectContract(third, "canonDepartments.list")) as {
      data: Row[];
      next_cursor: string | null;
    };
    expect(page3.data.map((r) => r["dept_code"])).toEqual(["4000"]);
    expect(page3.next_cursor).toBeNull();
  });

  it("returns a sparse fieldset with the key", async () => {
    const api = app(fakeDb(DEPARTMENTS));
    const res = await api.request("/canon/departments?fields=department&limit=1");
    const page = (await expectContract(res, "canonDepartments.list", { sparse: true })) as {
      data: Row[];
    };
    expect(page.data).toEqual([{ dept_code: "0000", department: "Department 0000" }]);
  });

  it("gets one department with an ETag and answers 404 for a missing code", async () => {
    const api = app(fakeDb(DEPARTMENTS));
    const res = await api.request("/canon/departments/4000");
    expect(res.headers.get("etag")).toMatch(/^W\//);
    expect(await expectContract(res, "canonDepartments.get")).toEqual(DEPARTMENTS[4]);
    const missing = await api.request("/canon/departments/9000");
    await expectContract(missing, "canonDepartments.get");
    expect(missing.status).toBe(404);
  });

  it("refuses a damaged cursor and unknown fields", async () => {
    const api = app(fakeDb(DEPARTMENTS));
    const cursor = await api.request("/canon/departments?cursor=xyz");
    expect(cursor.status).toBe(400);
    await expectContract(cursor, "canonDepartments.list");
    const fields = await api.request("/canon/departments?fields=nope");
    expect(fields.status).toBe(400);
  });

  it("answers 401 for an anonymous caller", async () => {
    const api = contractApp({ handlers: [handlers], anonymous: true });
    const res = await api.request("/canon/departments");
    expect(res.status).toBe(401);
    await expectContract(res, "canonDepartments.list");
  });

  it("maps a privilege error to 404", async () => {
    const api = app(fakeDb(DEPARTMENTS, { code: "42501", message: "permission denied" }));
    const res = await api.request("/canon/departments/4000");
    await expectContract(res, "canonDepartments.get");
    expect(res.status).toBe(404);
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

describe("contract validation", () => {
  it("checks the keywords the contract uses", () => {
    expect(
      validateSchema({ $ref: "#/components/schemas/CanonDepartment" }, { dept_code: "4000" }),
    ).toEqual(["/department is required", "/source is required", "/note is required"]);
    expect(validateSchema({ type: "string", format: "uuid" }, "x")).toEqual([
      "/ is not a valid uuid",
    ]);
    expect(validateSchema({ type: "string", format: "date-time" }, "2026-10-14T12:00:00Z")).toEqual(
      [],
    );
    expect(validateSchema({ type: "string", format: "date" }, "2026-13-45")).toHaveLength(1);
    expect(validateSchema({ type: "string", format: "email" }, "a@b.test")).toEqual([]);
    expect(validateSchema({ type: "string", format: "uri" }, "https://x.test")).toEqual([]);
    expect(
      validateSchema({ type: "string", minLength: 2, maxLength: 3, pattern: "^a" }, "bcde"),
    ).toHaveLength(2);
    expect(validateSchema({ type: "integer", minimum: 1, maximum: 2 }, 3)).toEqual([
      "/ is above 2",
    ]);
    expect(validateSchema({ type: "integer", minimum: 1 }, 0)).toEqual(["/ is below 1"]);
    expect(validateSchema({ type: "number" }, 2)).toEqual([]);
    expect(validateSchema({ type: "integer" }, 1.5)).toHaveLength(1);
    expect(validateSchema({ enum: ["a"] }, "b")).toHaveLength(1);
    expect(validateSchema({ const: 1 }, 2)).toHaveLength(1);
    expect(validateSchema({ allOf: [{ type: "string" }, { minLength: 2 }] }, "a")).toHaveLength(1);
    expect(validateSchema({ anyOf: [{ type: "string" }, { type: "null" }] }, 1)).toHaveLength(1);
    expect(validateSchema({ oneOf: [{ type: "number" }, { type: "integer" }] }, 1)).toHaveLength(1);
    expect(validateSchema({ type: "array", items: { type: "string" } }, ["a", 1])).toEqual([
      "/1 must be string, got integer",
    ]);
    expect(
      validateSchema({ type: "object", properties: {}, additionalProperties: false }, { x: 1 }),
    ).toEqual(["/x is not in the contract"]);
    expect(
      validateSchema({ type: "object", additionalProperties: { type: "string" } }, { x: 1 }),
    ).toHaveLength(1);
    expect(validateSchema(false, 1)).toHaveLength(1);
    expect(validateSchema(true, 1)).toEqual([]);
    expect(() => validateSchema({ $ref: "#/components/schemas/Nope" }, 1)).toThrow(/Unresolved/);
  });
});
