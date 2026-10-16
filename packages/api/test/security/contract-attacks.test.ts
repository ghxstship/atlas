/**
 * A22 security review (RRR-41): contract-level attack checks over the generated OpenAPI document.
 * - Every operation names the capability it needs, so API key and OAuth scopes always have a group
 *   to check (ADR 0003, ADR 0007).
 * - No request body accepts a server-set field, so mass assignment of tenancy, audit or approval
 *   columns is impossible through the contract (ADR 0007 item 1, ASVS V15.3.3).
 * - Every operation on one record names it by path id, and every POST requires Idempotency-Key.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Schema {
  readonly $ref?: string;
  readonly properties?: Record<string, unknown>;
  readonly allOf?: readonly Schema[];
  readonly anyOf?: readonly Schema[];
  readonly oneOf?: readonly Schema[];
}

interface Operation {
  readonly operationId: string;
  readonly "x-xos-capability"?: string;
  readonly parameters?: readonly {
    readonly name?: string;
    readonly in?: string;
    readonly $ref?: string;
  }[];
  readonly requestBody?: { readonly content?: Record<string, { readonly schema?: Schema }> };
}

const document = JSON.parse(
  readFileSync(new URL("../../openapi/v1.json", import.meta.url), "utf8"),
) as {
  paths: Record<string, Record<string, Operation>>;
  components?: {
    schemas?: Record<string, Schema>;
    parameters?: Record<string, { name: string; in: string }>;
  };
};

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods)
    .filter(([method]) => METHODS.has(method))
    .map(([method, op]) => ({ path, method, op })),
);

function propertiesOf(schema: Schema | undefined, depth = 0): Set<string> {
  const out = new Set<string>();
  if (schema === undefined || depth > 8) return out;
  if (schema.$ref !== undefined) {
    const name = schema.$ref.split("/").pop() as string;
    return propertiesOf(document.components?.schemas?.[name], depth + 1);
  }
  for (const part of [...(schema.allOf ?? []), ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    for (const key of propertiesOf(part, depth + 1)) out.add(key);
  }
  for (const key of Object.keys(schema.properties ?? {})) out.add(key);
  return out;
}

/** Columns only the database sets: tenancy, audit stamps, approvals and secrets. */
const SERVER_SET = [
  "org_id",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
  "deleted_at",
  "approved_at",
  "approved_by",
  "posted_at",
  "posted_by",
  "resolved_by",
  "secret_hash",
  "token_hash",
  "is_masked",
];

describe("A22 contract attacks", () => {
  it("covers the whole catalog", () => {
    expect(operations.length).toBeGreaterThan(1000);
  });

  it("names a capability on every operation, so scopes always apply", () => {
    const missing = operations
      .filter(({ op }) => !op["x-xos-capability"])
      .map(({ op }) => op.operationId);
    expect(missing).toEqual([]);
  });

  it("accepts no server-set field in any request body", () => {
    const offenders = operations.flatMap(({ op }) => {
      const props = propertiesOf(op.requestBody?.content?.["application/json"]?.schema);
      return SERVER_SET.filter((field) => props.has(field)).map((f) => `${op.operationId}.${f}`);
    });
    expect(offenders).toEqual([]);
  });

  it("requires Idempotency-Key on every POST", () => {
    const missing = operations
      .filter(({ method }) => method === "post")
      .filter(({ op }) => !(op.parameters ?? []).some((p) => p.$ref?.endsWith("/IdempotencyKey")))
      .map(({ op }) => op.operationId);
    expect(missing).toEqual([]);
  });

  it("never takes the organization from the path or query", () => {
    const offenders = operations
      .filter(
        ({ path, op }) =>
          /\{org(_id|Id)?\}/.test(path) || (op.parameters ?? []).some((p) => p.name === "org_id"),
      )
      .map(({ op }) => op.operationId);
    expect(offenders).toEqual([]);
  });
});
