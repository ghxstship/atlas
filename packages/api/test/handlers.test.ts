/**
 * The handler seam: the generated index and operation types are fresh, handlers mount only where
 * they exist, and the runtime applies the request conventions around them.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { XosClient } from "@xos/data";
import { catalogOperationIds, createApiApp, handledOperations } from "../src/app.ts";
import {
  HANDLER_INDEX_FILE,
  OPERATION_TYPES_FILE,
  handlerModules,
  moduleFileName,
  renderHandlerIndex,
  renderOperationTypes,
  schemaType,
} from "../src/codegen/handlers.ts";
import { MODULES } from "../src/catalog/types.ts";
import { refused } from "../src/problem.ts";
import type { RequestContext } from "../src/runtime/context.ts";
import { created, defineHandlers, noContent, ok } from "../src/runtime/handler.ts";
import type { AnyModuleHandlers } from "../src/runtime/handler.ts";
import { parseQuery } from "../src/runtime/query.ts";

const context: RequestContext = {
  user: { id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f", email: "ada@example.com" },
  personId: "0192f1e2-7c3a-7b4d-9e8f-00000000000p",
  org: { id: "0192f1e2-7c3a-7b4d-9e8f-000000000001", slug: "demo" },
  locale: "en-US",
  db: {} as XosClient,
  credential: "session",
  requestId: "req-1",
};

const authenticate = async (request: Request) =>
  request.headers.get("authorization") === "Bearer good" ? context : null;

const auth = { authorization: "Bearer good" };

const project = {
  id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
  org_id: "0192f1e2-7c3a-7b4d-9e8f-000000000001",
};

function app(handlers: readonly AnyModuleHandlers[], validateResponses = false) {
  const errors: unknown[] = [];
  const instance = createApiApp({
    authenticate,
    handlers,
    validateResponses,
    onError: (e) => errors.push(e),
    requestId: () => "req-1",
  });
  return { instance, errors };
}

describe("generated files", () => {
  it("keeps the handler index fresh", async () => {
    expect(readFileSync(HANDLER_INDEX_FILE, "utf8")).toBe(await renderHandlerIndex());
  });

  it("keeps the operation types fresh", async () => {
    expect(readFileSync(OPERATION_TYPES_FILE, "utf8")).toBe(await renderOperationTypes());
  });

  it("has one handler file per module, named in kebab-case", () => {
    expect(handlerModules()).toEqual([...MODULES]);
    expect(moduleFileName("Home")).toBe("home.ts");
    expect(moduleFileName("WhiteLabel")).toBe("white-label.ts");
  });

  it("converts JSON Schema to TypeScript", () => {
    expect(schemaType({ type: ["string", "null"] })).toBe("(string) | (null)");
    expect(schemaType({ enum: ["a", "b"] })).toBe('("a") | ("b")');
    expect(schemaType({ const: true })).toBe("true");
    expect(schemaType({ allOf: [{ $ref: "#/components/schemas/A" }, { type: "boolean" }] })).toBe(
      '(Components["A"]) & (boolean)',
    );
    expect(schemaType({ type: "array", prefixItems: [{ type: "number" }] })).toBe("[number]");
    expect(schemaType({ type: "object", additionalProperties: { type: "string" } })).toBe(
      "Record<string, string>",
    );
    expect(
      schemaType({
        type: "object",
        properties: { "a-b": { type: "integer" } },
        additionalProperties: true,
      }),
    ).toBe('{ "a-b"?: number; [key: string]: unknown; }');
    expect(schemaType({ type: "object", additionalProperties: false })).toBe(
      "Record<string, never>",
    );
    expect(schemaType({})).toBe("unknown");
    expect(schemaType(false)).toBe("never");
  });
});

describe("mounting", () => {
  it("mounts no handler without dependencies", () => {
    expect(createApiApp().routes).toHaveLength(0);
  });

  it("serves the exemplar and leaves every other operation out of the router", async () => {
    const { instance } = app([]);
    const res = await instance.request("/projects", { headers: auth });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(handledOperations()).toEqual(
      expect.arrayContaining(["canonDepartments.list", "canonDepartments.get"]),
    );
    expect(handledOperations().every((op) => catalogOperationIds().includes(op))).toBe(true);
    expect(catalogOperationIds().length).toBeGreaterThan(1000);
  });

  it("refuses a handler for an unknown operation or another module", () => {
    const unknown = { module: "Projects", handlers: { "projects.fly": async () => ok({}) } };
    expect(() => app([unknown as unknown as AnyModuleHandlers])).toThrow(/names no operation/);
    const wrong = { module: "Home", handlers: { "projects.list": async () => ok({}) } };
    expect(() => app([wrong as unknown as AnyModuleHandlers])).toThrow(/belongs to Projects/);
  });

  it("matches a static segment before a parameter", async () => {
    const handlers = defineHandlers("Canon", {
      "canonElements.get": async () => {
        throw new Error("The parameter route must not win.");
      },
      "canonElements.resolve": async () => ok({ data: [], next_cursor: null } as never),
    });
    const { instance } = app([handlers]);
    const res = await instance.request("/canon/elements/resolve?query=deck", { headers: auth });
    expect(res.status).toBe(200);
  });
});

describe("request conventions", () => {
  const projects = defineHandlers("Projects", {
    "projects.list": async ({ query }) =>
      ok({
        data: [],
        next_cursor: query.filter === undefined ? null : JSON.stringify(query.filter),
      } as never),
    "projects.create": async ({ idempotencyKey, body }) => {
      expect(idempotencyKey).toBe("key-12345");
      return created({ ...project, ...(body as object) } as never);
    },
    "projects.update": async ({ ifMatch }) => {
      if (ifMatch !== '"W/1"') throw refused("REFUSE", "Stale.", "test.rule");
      return ok(project as never);
    },
    "projects.delete": async () => {
      throw {
        code: "XR001",
        message: "sod.po.creator_cannot_approve: The creator cannot approve.",
        hint: "sod.po.creator_cannot_approve",
      };
    },
    "projects.get": async () => noContent() as never,
  });

  it("answers 401 without a valid credential", async () => {
    const { instance } = app([projects]);
    const res = await instance.request("/projects");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    const body = (await res.json()) as { type: string; instance: string };
    expect(body.type).toBe("/problems/unauthorized");
    expect(body.instance).toBe("/projects");
  });

  it("validates the query and parses the filter grammar", async () => {
    const { instance } = app([projects]);
    const bad = await instance.request("/projects?limit=500", { headers: auth });
    expect(bad.status).toBe(422);
    const problem = (await bad.json()) as { errors: { pointer: string }[] };
    expect(problem.errors[0]?.pointer).toBe("/query/limit");

    const filtered = await instance.request("/projects?filter[project_state][eq]=Active", {
      headers: auth,
    });
    expect(filtered.status).toBe(200);
    expect(filtered.headers.get("x-request-id")).toBe("req-1");
    const page = (await filtered.json()) as { next_cursor: string };
    expect(JSON.parse(page.next_cursor)).toEqual({ project_state: { eq: "Active" } });

    const unknownOp = await instance.request("/projects?filter[project_state][like]=A", {
      headers: auth,
    });
    expect(unknownOp.status).toBe(422);
  });

  it("requires Idempotency-Key and a JSON body on POST", async () => {
    const { instance } = app([projects]);
    const missing = await instance.request("/projects", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(400);
    const notJson = await instance.request("/projects", {
      method: "POST",
      headers: { ...auth, "idempotency-key": "key-12345", "content-type": "text/plain" },
      body: "x",
    });
    expect(notJson.status).toBe(400);
    const broken = await instance.request("/projects", {
      method: "POST",
      headers: { ...auth, "idempotency-key": "key-12345", "content-type": "application/json" },
      body: "{",
    });
    expect(broken.status).toBe(400);
    const invalid = await instance.request("/projects", {
      method: "POST",
      headers: { ...auth, "idempotency-key": "short", "content-type": "application/json" },
      body: "{}",
    });
    expect(invalid.status).toBe(422);
    const pointers = ((await invalid.json()) as { errors: { pointer: string }[] }).errors.map(
      (e) => e.pointer,
    );
    expect(pointers).toContain("/headers/Idempotency-Key");
  });

  it("requires If-Match on PATCH and maps refusals", async () => {
    const { instance } = app([projects]);
    const path = `/projects/${project.id}`;
    const headers = { ...auth, "content-type": "application/json" };
    const missing = await instance.request(path, { method: "PATCH", headers, body: "{}" });
    expect(missing.status).toBe(428);
    const stale = await instance.request(path, {
      method: "PATCH",
      headers: { ...headers, "if-match": '"W/0"' },
      body: "{}",
    });
    expect(stale.status).toBe(422);
    expect(await stale.json()).toMatchObject({ refusal: "REFUSE", rule: "test.rule" });
  });

  it("maps SQLSTATE XR001 to a refusal carrying its rule", async () => {
    const { instance } = app([projects]);
    const res = await instance.request(`/projects/${project.id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      type: "/problems/refused",
      refusal: "REFUSE",
      reason: "The creator cannot approve.",
      rule: "sod.po.creator_cannot_approve",
    });
  });

  it("answers 500 for an undocumented status and reports the error", async () => {
    const { instance, errors } = app([projects]);
    const res = await instance.request(`/projects/${project.id}`, { headers: auth });
    expect(res.status).toBe(500);
    expect(errors).toHaveLength(1);
    expect(((await res.json()) as { detail: string }).detail).toContain("req-1");
  });

  it("rejects a body outside the contract when validating responses", async () => {
    const { instance, errors } = app([projects], true);
    expect((await instance.request("/projects", { headers: auth })).status).toBe(200);
    const broken = defineHandlers("Projects", {
      "projects.list": async () => ok({ data: [{ id: 1 }], next_cursor: null } as never),
    });
    const strict = app([broken], true);
    const res = await strict.instance.request("/projects", { headers: auth });
    expect(res.status).toBe(500);
    expect(String(strict.errors[0])).toMatch(/outside its contract/);
    expect(errors).toHaveLength(0);
  });
});

describe("query parsing", () => {
  it("keeps the first value of a plain parameter and nests filters", () => {
    const q = parseQuery(new URLSearchParams("limit=5&limit=9&filter[a][eq]=1&filter[a][ne]=2"));
    expect(q).toEqual({ limit: "5", filter: { a: { eq: "1", ne: "2" } } });
  });

  it("surfaces a malformed filter key", () => {
    expect(parseQuery(new URLSearchParams("filter[a]=1"))).toEqual({
      filter: { "filter[a]": { "": "1" } },
    });
  });
});
