/**
 * Contract-test helpers for module agents (Section 18, gate 5). Every handler test runs requests
 * through `contractApp` and checks each response with `expectContract(response, operationId)`,
 * which validates status, media type and body against the published OpenAPI document
 * (`openapi/v1.json`), independently of the zod schemas the runtime uses. The operation coverage
 * test fails when a handled operation is never named in an `expectContract` call.
 *
 *   const app = contractApp({ handlers: [handlers], db });
 *   const res = await app.request("/canon/departments");
 *   const page = await expectContract(res, "canonDepartments.list");
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { XosClient } from "@xos/data";
import { createApiApp } from "../../src/app.ts";
import type { RequestContext } from "../../src/runtime/context.ts";
import type { AnyModuleHandlers } from "../../src/runtime/handler.ts";
import type {
  BeginOutcome,
  IdempotencyStore,
  StoredResponse,
} from "../../src/runtime/idempotency.ts";

type Json = Record<string, unknown>;

interface Document {
  readonly paths: Record<string, Record<string, Json>>;
  readonly components: Record<string, Record<string, Json>>;
}

export const contractDocument = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../openapi/v1.json", import.meta.url)), "utf8"),
) as Document;

const METHODS = ["get", "post", "put", "patch", "delete"];

export interface ContractOperation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly operation: Json;
}

export const contractOperations: ReadonlyMap<string, ContractOperation> = new Map(
  Object.entries(contractDocument.paths).flatMap(([path, item]) =>
    METHODS.filter((m) => item[m] !== undefined).map((method) => {
      const operation = item[method] as Json;
      const operationId = operation["operationId"] as string;
      return [operationId, { operationId, method, path, operation }] as const;
    }),
  ),
);

function resolve(node: Json): Json {
  let current = node;
  for (let depth = 0; typeof current["$ref"] === "string"; depth += 1) {
    if (depth > 20) throw new Error(`Reference cycle at ${String(current["$ref"])}`);
    const [, , kind, name] = (current["$ref"] as string).split("/");
    const target = contractDocument.components[kind as string]?.[name as string];
    if (target === undefined) throw new Error(`Unresolved ${String(current["$ref"])}`);
    current = target;
  }
  return current;
}

const FORMATS: Record<string, (value: string) => boolean> = {
  uuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  "date-time": (v) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) &&
    !Number.isNaN(Date.parse(v)),
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
  email: (v) => /^[^@\s]+@[^@\s]+$/.test(v),
  uri: (v) => /^[a-z][a-z0-9+.-]*:/i.test(v),
};

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** JSON Schema validation for the keywords the contract uses. Returns one message per violation. */
export function validateSchema(schemaNode: unknown, value: unknown, at = ""): string[] {
  if (schemaNode === true || schemaNode === undefined) return [];
  if (schemaNode === false) return [`${at || "/"} is not allowed`];
  const schema = resolve(schemaNode as Json);
  const errors: string[] = [];
  const here = at || "/";
  if (Array.isArray(schema["allOf"])) {
    for (const part of schema["allOf"]) errors.push(...validateSchema(part, value, at));
  }
  if (Array.isArray(schema["anyOf"]) || Array.isArray(schema["oneOf"])) {
    const options = (schema["anyOf"] ?? schema["oneOf"]) as unknown[];
    const passing = options.filter((o) => validateSchema(o, value, at).length === 0).length;
    if (passing === 0) errors.push(`${here} matches none of the allowed shapes`);
    if (schema["oneOf"] !== undefined && passing > 1)
      errors.push(`${here} matches more than one shape`);
  }
  if ("const" in schema && JSON.stringify(schema["const"]) !== JSON.stringify(value)) {
    errors.push(`${here} must be ${JSON.stringify(schema["const"])}`);
  }
  if (
    Array.isArray(schema["enum"]) &&
    !schema["enum"].some((e) => JSON.stringify(e) === JSON.stringify(value))
  ) {
    errors.push(
      `${here} must be one of ${schema["enum"].map((e) => JSON.stringify(e)).join(", ")}`,
    );
  }
  const type = schema["type"];
  if (type !== undefined) {
    const types = Array.isArray(type) ? (type as string[]) : [type as string];
    const actual = typeOf(value);
    if (!types.includes(actual) && !(actual === "integer" && types.includes("number"))) {
      errors.push(`${here} must be ${types.join(" or ")}, got ${actual}`);
      return errors;
    }
  }
  if (typeof value === "string") {
    if (typeof schema["minLength"] === "number" && [...value].length < schema["minLength"]) {
      errors.push(`${here} is shorter than ${schema["minLength"]}`);
    }
    if (typeof schema["maxLength"] === "number" && [...value].length > schema["maxLength"]) {
      errors.push(`${here} is longer than ${schema["maxLength"]}`);
    }
    if (typeof schema["pattern"] === "string" && !new RegExp(schema["pattern"], "u").test(value)) {
      errors.push(`${here} does not match ${schema["pattern"]}`);
    }
    const check = typeof schema["format"] === "string" ? FORMATS[schema["format"]] : undefined;
    if (check !== undefined && !check(value))
      errors.push(`${here} is not a valid ${String(schema["format"])}`);
  }
  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) {
      errors.push(`${here} is below ${schema["minimum"]}`);
    }
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) {
      errors.push(`${here} is above ${schema["maximum"]}`);
    }
  }
  if (Array.isArray(value) && schema["items"] !== undefined) {
    value.forEach((item, i) => errors.push(...validateSchema(schema["items"], item, `${at}/${i}`)));
  }
  if (typeOf(value) === "object") {
    const object = value as Json;
    const properties = (schema["properties"] ?? {}) as Record<string, unknown>;
    for (const name of (schema["required"] ?? []) as string[]) {
      if (!(name in object)) errors.push(`${at}/${name} is required`);
    }
    for (const [name, member] of Object.entries(object)) {
      if (name in properties)
        errors.push(...validateSchema(properties[name], member, `${at}/${name}`));
      else if (schema["additionalProperties"] === false)
        errors.push(`${at}/${name} is not in the contract`);
      else if (typeof schema["additionalProperties"] === "object") {
        errors.push(...validateSchema(schema["additionalProperties"], member, `${at}/${name}`));
      }
    }
  }
  return errors;
}

/** The documented response of an operation for a status, with references resolved. */
export function documentedResponse(operationId: string, status: number): Json | undefined {
  const op = contractOperations.get(operationId);
  if (op === undefined) throw new Error(`${operationId} is not in the contract.`);
  const responses = op.operation["responses"] as Record<string, Json>;
  const response = responses[String(status)];
  return response === undefined ? undefined : resolve(response);
}

/**
 * Asserts a response is one the contract documents for `operationId`: a documented status, the
 * documented media type, and a body valid against the documented schema. With `sparse`, missing
 * members are allowed (a `fields` request). Returns the parsed body.
 */
export async function expectContract(
  response: Response,
  operationId: string,
  options: { readonly sparse?: boolean } = {},
): Promise<unknown> {
  const documented = documentedResponse(operationId, response.status);
  expect(documented, `${operationId} does not document status ${response.status}`).toBeDefined();
  const content = (documented?.["content"] ?? {}) as Record<string, Json>;
  const mediaTypes = Object.keys(content);
  if (mediaTypes.length === 0) {
    expect(await response.text(), `${operationId} ${response.status} has no body`).toBe("");
    return undefined;
  }
  const mediaType = (response.headers.get("content-type") ?? "").split(";")[0] as string;
  expect(mediaTypes, `${operationId} ${response.status} media type`).toContain(mediaType);
  const body = (await response.json()) as unknown;
  const schema = content[mediaType]?.["schema"];
  const errors = validateSchema(schema, body).filter(
    (e) => !(options.sparse === true && e.endsWith("is required")),
  );
  expect(errors, `${operationId} ${response.status} body`).toEqual([]);
  return body;
}

/** A request context for handler tests, acting for one member of one org. */
export function testContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    user: { id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f", email: "member@example.test" },
    personId: "0192f1e2-7c3a-7b4d-9e8f-00000000000a",
    org: { id: "0192f1e2-7c3a-7b4d-9e8f-000000000001", slug: "northwind-live" },
    locale: "en-US",
    db: {} as XosClient,
    credential: "session",
    requestId: "req-test",
    ...overrides,
  };
}

/** An Idempotency-Key ledger held in memory, with A18's outcomes. */
export function memoryIdempotencyStore(): IdempotencyStore & { readonly size: () => number } {
  const rows = new Map<string, { hash: string; response?: StoredResponse }>();
  return {
    size: () => rows.size,
    async begin(_context, key, hash): Promise<BeginOutcome> {
      const row = rows.get(key);
      if (row === undefined) {
        rows.set(key, { hash: hash.toString("hex") });
        return { outcome: "proceed" };
      }
      if (row.hash !== hash.toString("hex")) return { outcome: "mismatch" };
      return row.response === undefined
        ? { outcome: "in_progress" }
        : { outcome: "replay", response: row.response };
    },
    async complete(_context, key, response) {
      const row = rows.get(key);
      if (row !== undefined) row.response = response;
    },
    async abandon(_context, key) {
      rows.delete(key);
    },
  };
}

export interface ContractAppOptions {
  readonly handlers: readonly AnyModuleHandlers[];
  /** The caller's database client; a test double or a client for the shared stack. */
  readonly db?: unknown;
  readonly context?: Partial<RequestContext>;
  /** Null answers 401, as an anonymous caller. */
  readonly anonymous?: boolean;
}

/** The API app with the given handlers, a fixed caller, response validation on and no rate limit. */
export function contractApp(options: ContractAppOptions) {
  const context = testContext({
    ...(options.db === undefined ? {} : { db: options.db as XosClient }),
    ...options.context,
  });
  const errors: unknown[] = [];
  const app = createApiApp({
    handlers: options.handlers,
    authenticate: async () => (options.anonymous === true ? null : context),
    validateResponses: true,
    rateLimiter: false,
    idempotency: memoryIdempotencyStore(),
    onError: (error) => errors.push(error),
    requestId: () => "req-test",
  });
  return Object.assign(app, { errors });
}
