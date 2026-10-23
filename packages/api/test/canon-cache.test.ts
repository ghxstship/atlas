/**
 * A65-032 regression: canon URLs carry the generation and set immutable caching (Section 5.1).
 */
import { describe, expect, it } from "vitest";
import type { XosClient } from "@xos/data";
import { handlers } from "../src/handlers/canon.ts";
import {
  CANON_GENERATION_HEADER,
  IMMUTABLE,
  NO_STORE,
  REVALIDATE,
  canonCacheDecision,
  isCanonRead,
  readCanonGeneration,
  withGeneration,
} from "../src/runtime/canon-cache.ts";
import type { RequestContext } from "../src/runtime/context.ts";
import { contractApp, expectContract } from "./support/contract.ts";

const DEPARTMENT = {
  dept_code: "1000",
  department: "Production",
  source: "canon",
  note: null,
  executive_lead: null,
  core_function: null,
  scope: null,
};

/** A client whose every query answers `rows`, recording the tables it was asked for. */
function fakeDb(rows: Record<string, unknown>[], tables: string[] = []): XosClient {
  const query = {
    select: () => query,
    order: () => query,
    limit: () => query,
    eq: () => query,
    gt: () => query,
    or: () => query,
    maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
  };
  return {
    schema: () => ({
      from: (table: string) => {
        tables.push(table);
        return query;
      },
    }),
  } as unknown as XosClient;
}

const app = (generation: number | null) =>
  contractApp({
    handlers: [handlers],
    db: fakeDb([DEPARTMENT]),
    context: { org: null, personId: null },
    canonGeneration: async () => generation,
  });

describe("canon generation caching", () => {
  it("caches a read at the current generation for good", async () => {
    const res = await app(4).request("/canon/departments/1000?generation=4");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(res.headers.get(CANON_GENERATION_HEADER)).toBe("4");
    expect(await expectContract(res, "canonDepartments.get")).toEqual(DEPARTMENT);
  });

  it("revalidates a read without a generation and names the cacheable URL", async () => {
    const res = await app(4).request("/canon/departments?limit=1&fields=department");
    expect(res.headers.get("cache-control")).toBe(REVALIDATE);
    expect(res.headers.get(CANON_GENERATION_HEADER)).toBe("4");
    expect(res.headers.get("content-location")).toBe("?limit=1&fields=department&generation=4");
    await expectContract(res, "canonDepartments.list", { sparse: true });
  });

  it("moves an old or unknown generation to the current one without caching the answer", async () => {
    for (const old of ["3", "5", "latest"]) {
      const res = await app(4).request(`/canon/departments?limit=1&generation=${old}`);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("?limit=1&generation=4");
      expect(res.headers.get("cache-control")).toBe(NO_STORE);
      expect(await res.text()).toBe("");
    }
  });

  it("caches nothing when the generation cannot be read", async () => {
    const res = await app(null).request("/canon/departments/1000?generation=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(res.headers.get(CANON_GENERATION_HEADER)).toBeNull();
  });

  it("leaves errors and the one canon write uncached", async () => {
    const missing = await contractApp({
      handlers: [handlers],
      db: fakeDb([]),
      context: { org: null, personId: null },
      canonGeneration: async () => 4,
    }).request("/canon/departments/9000?generation=4");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBeNull();
    expect(isCanonRead({ module: "Canon", method: "post" })).toBe(false);
    expect(isCanonRead({ module: "Projects", method: "get" })).toBe(false);
    expect(isCanonRead({ module: "Canon", method: "get" })).toBe(true);
  });

  it("reads the generation from xpms.version through the caller's client by default", async () => {
    const tables: string[] = [];
    const api = contractApp({
      handlers: [handlers],
      db: fakeDb([{ ...DEPARTMENT, generation: 2 }], tables),
      context: { org: null, personId: null },
    });
    const res = await api.request("/canon/departments/1000?generation=2");
    expect(res.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(tables[0]).toBe("version");
  });
});

describe("readCanonGeneration", () => {
  const contextWith = (db: unknown) => ({ db }) as unknown as RequestContext;

  it("answers the highest generation, or null when it is missing, invalid or unreadable", async () => {
    expect(await readCanonGeneration(contextWith(fakeDb([{ generation: 7 }])))).toBe(7);
    expect(await readCanonGeneration(contextWith(fakeDb([])))).toBeNull();
    expect(await readCanonGeneration(contextWith(fakeDb([{ generation: "x" }])))).toBeNull();
    const failing = {
      schema: () => ({
        from: () => ({
          select: () => ({
            order: () => ({ limit: async () => ({ data: null, error: { message: "denied" } }) }),
          }),
        }),
      }),
    };
    expect(await readCanonGeneration(contextWith(failing))).toBeNull();
    const throwing = {
      schema: () => {
        throw new Error("offline");
      },
    };
    expect(await readCanonGeneration(contextWith(throwing))).toBeNull();
  });
});

describe("canonCacheDecision", () => {
  it("keeps every other query parameter in the generation URL", () => {
    const url = new URL(
      "https://api.example.test/v1/canon/elements?filter[tier][eq]=2&generation=1",
    );
    expect(withGeneration(url, 3)).toBe("?filter%5Btier%5D%5Beq%5D=2&generation=3");
    expect(canonCacheDecision(url, 3)).toEqual({
      kind: "redirect",
      location: "?filter%5Btier%5D%5Beq%5D=2&generation=3",
      headers: {
        [CANON_GENERATION_HEADER]: "3",
        "Cache-Control": NO_STORE,
        Location: "?filter%5Btier%5D%5Beq%5D=2&generation=3",
      },
    });
  });
});
