/**
 * Contract tests for the generated OpenAPI document (ADR 0003, Section 18 gates 5, 13 and 20).
 */
import { readFileSync } from "node:fs";
import { Validator } from "@seriousme/openapi-schema-validator";
import { beforeAll, describe, expect, it } from "vitest";
import { MODULES, buildOpenApiDocument, catalog } from "../src/index.ts";
import { SECTION_COVERAGE } from "../src/catalog/coverage.ts";
import { DOCUMENT_FILE, renderOpenApiDocument } from "../src/document.ts";

type Json = Record<string, unknown>;
interface Operation extends Json {
  operationId: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Json[];
  requestBody?: { content: Record<string, Json> };
  responses: Record<string, Json>;
}

const doc = buildOpenApiDocument() as Json & {
  paths: Record<string, Record<string, Operation>>;
  components: Record<string, Record<string, Json>>;
};

const METHODS = ["get", "post", "patch", "put", "delete"];
const operations: { method: string; path: string; op: Operation }[] = Object.entries(
  doc.paths,
).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([m]) => METHODS.includes(m))
    .map(([method, op]) => ({ method, path, op })),
);

function deref(obj: Json): Json {
  const ref = obj["$ref"];
  if (typeof ref !== "string") return obj;
  const [, , kind, name] = ref.split("/");
  const target = doc.components[kind as string]?.[name as string];
  if (target === undefined) throw new Error(`Unresolved ${ref}`);
  return deref(target);
}

/** Views (`v_` tables) are derived rows without an ETag. */
function hasResourceBody(op: Operation): boolean {
  return !/\.v_/.test(String(op["x-xos-table"]));
}

function headerParams(op: Operation): string[] {
  return (op.parameters ?? [])
    .map(deref)
    .filter((p) => p["in"] === "header")
    .map((p) => String(p["name"]));
}

/** Compares codes like 0000.01 and 4000.02.01 segment by segment, numerically. */
function compareCodes(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const pa = String(a).match(/\d+|\D+/g) ?? [];
  const pb = String(b).match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    if (x === y) continue;
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx - ny;
    return x < y ? -1 : 1;
  }
  return 0;
}

describe("OpenAPI document", () => {
  let validation: { valid: boolean; errors?: unknown };

  beforeAll(async () => {
    const validator = new Validator();
    validation = await validator.validate(JSON.parse(JSON.stringify(doc)));
  });

  it("validates as OpenAPI 3.1", () => {
    expect(doc["openapi"]).toBe("3.1.0");
    expect(validation.errors).toBeUndefined();
    expect(validation.valid).toBe(true);
  });

  it("matches the committed file byte for byte", async () => {
    const committed = readFileSync(DOCUMENT_FILE, "utf8");
    expect(committed === (await renderOpenApiDocument())).toBe(true);
  });

  it("is generated deterministically", () => {
    expect(JSON.stringify(buildOpenApiDocument())).toBe(JSON.stringify(doc));
  });

  it("covers a large operation set", () => {
    expect(operations.length).toBeGreaterThan(1000);
  });

  it("declares the three security schemes and applies them globally", () => {
    const schemes = doc.components["securitySchemes"] as Record<string, Json>;
    expect(Object.keys(schemes).sort()).toEqual(["apiKey", "bearerJwt", "oauth2"]);
    const oauth = schemes["oauth2"] as { flows: Record<string, unknown> };
    expect(Object.keys(oauth.flows)).toEqual(["authorizationCode"]);
    expect(doc["security"]).toEqual([{ bearerJwt: [] }, { apiKey: [] }, { oauth2: [] }]);
  });
});

describe("every operation", () => {
  it("has a unique {resource}.{verb} operationId", () => {
    const ids = operations.map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/);
  });

  it("has a summary, a description and a module tag", () => {
    for (const { op } of operations) {
      expect(op.summary, op.operationId).toBeTruthy();
      expect((op.description ?? "").length, op.operationId).toBeGreaterThan(20);
      expect(op.tags?.length, op.operationId).toBe(1);
      expect(MODULES).toContain(op.tags?.[0]);
    }
  });

  it("has at least one example", () => {
    for (const { op } of operations) {
      const success = Object.entries(op.responses).filter(([s]) => s.startsWith("2"));
      const responseExample = success.some(([, r]) =>
        Object.values((r["content"] as Record<string, Json> | undefined) ?? {}).some(
          (m) => m["example"] !== undefined || m["examples"] !== undefined,
        ),
      );
      const bodyExample = Object.values(op.requestBody?.content ?? {}).some(
        (m) => m["example"] !== undefined,
      );
      const paramExample = (op.parameters ?? [])
        .map(deref)
        .some(
          (p) =>
            p["example"] !== undefined ||
            (p["schema"] as Json | undefined)?.["example"] !== undefined,
        );
      expect(responseExample || bodyExample || paramExample, op.operationId).toBe(true);
      if (op.requestBody !== undefined) expect(bodyExample, op.operationId).toBe(true);
    }
  });

  it("declares Idempotency-Key on every POST", () => {
    const posts = operations.filter((o) => o.method === "post");
    expect(posts.length).toBeGreaterThan(100);
    for (const { op } of posts)
      expect(headerParams(op), op.operationId).toContain("Idempotency-Key");
  });

  it("declares If-Match on every PATCH and documents 412 and 428", () => {
    const patches = operations.filter((o) => o.method === "patch");
    expect(patches.length).toBeGreaterThan(100);
    for (const { op } of patches) {
      expect(headerParams(op), op.operationId).toContain("If-Match");
      expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(["412", "428"]));
    }
  });

  it("returns an ETag from single-resource reads and writes", () => {
    for (const { op } of operations) {
      if (!/\.(get|update|create)$/.test(op.operationId) || !hasResourceBody(op)) continue;
      const ok = deref(op.responses["200"] ?? op.responses["201"] ?? {});
      expect(Object.keys((ok["headers"] as Json | undefined) ?? {}), op.operationId).toContain(
        "ETag",
      );
    }
  });

  it("uses application/problem+json for every error response", () => {
    for (const { op } of operations) {
      for (const [status, raw] of Object.entries(op.responses)) {
        if (!/^[45]/.test(status)) continue;
        const res = deref(raw);
        expect(
          Object.keys((res["content"] as Json | undefined) ?? {}),
          `${op.operationId} ${status}`,
        ).toEqual(["application/problem+json"]);
      }
      expect(
        Object.keys(op.responses).some((s) => s.startsWith("4")),
        op.operationId,
      ).toBe(true);
    }
  });

  it("documents 422 refusals on every action and create", () => {
    for (const { method, op } of operations) {
      if (method !== "post") continue;
      expect(Object.keys(op.responses), op.operationId).toContain("422");
    }
    const unprocessable = deref({ $ref: "#/components/responses/Unprocessable" }) as {
      content: Record<string, { examples: Record<string, { value: Json }> }>;
    };
    const refusal = unprocessable.content["application/problem+json"]?.examples["refusal"]?.value;
    expect(refusal?.["refusal"]).toBe("REFUSE");
    const refusalEnum = deref({ $ref: "#/components/schemas/Refusal" })["enum"];
    expect(refusalEnum).toEqual(["NO_ANSWER", "UNRATIFIED", "REFUSE"]);
  });

  it("paginates every list with a cursor envelope", () => {
    for (const { op } of operations.filter((o) => o.op.operationId.endsWith(".list"))) {
      const params = (op.parameters ?? []).map(deref).map((p) => p["name"]);
      expect(params, op.operationId).toEqual(
        expect.arrayContaining(["limit", "cursor", "fields", "sort", "filter"]),
      );
      const content = deref(op.responses["200"] as Json)["content"] as Record<
        string,
        { example: Json }
      >;
      expect(Object.keys(content["application/json"]?.example ?? {})).toEqual([
        "data",
        "next_cursor",
      ]);
    }
  });
});

describe("doctrine in the contract", () => {
  it("documents coded lists in numeric order", () => {
    const coded = operations.filter(
      (o) => (o.op["x-xos-order"] as { numeric?: boolean } | undefined)?.numeric,
    );
    expect(coded.length).toBeGreaterThan(15);
    for (const { op } of coded) {
      const order = op["x-xos-order"] as { by: string[] };
      expect(op.description, op.operationId).toContain("numeric code order");
      const content = deref(op.responses["200"] as Json)["content"] as Record<
        string,
        { example: { data: Json[] } }
      >;
      const data = content["application/json"]?.example.data ?? [];
      expect(data.length, op.operationId).toBeGreaterThan(1);
      for (let i = 1; i < data.length; i++) {
        const prev = data[i - 1] as Json;
        const cur = data[i] as Json;
        const cmp = order.by.map((f) => compareCodes(prev[f], cur[f])).find((x) => x !== 0) ?? 0;
        expect(cmp, op.operationId).toBeLessThan(0);
      }
    }
  });

  it("keeps money as nullable integer minor units", () => {
    let count = 0;
    for (const [name, schema] of Object.entries(doc.components["schemas"] ?? {})) {
      if (name.endsWith("Create") || name.endsWith("Update")) continue;
      const props = (schema["properties"] as Record<string, Json> | undefined) ?? {};
      for (const [field, prop] of Object.entries(props)) {
        if (!field.endsWith("_minor") || prop["anyOf"] !== undefined) continue;
        count++;
        expect(prop["type"], `${name}.${field}`).toEqual(["integer", "null"]);
      }
    }
    expect(count).toBeGreaterThan(30);
    const total = doc.components["schemas"]?.["MoneyTotal"] as { properties: Record<string, Json> };
    expect(Object.keys(total.properties)).toEqual(["total_minor", "currency", "unpriced_count"]);
  });

  it("returns Restricted fields in the masked shape", () => {
    const payRate = doc.components["schemas"]?.["PayRate"] as { properties: Record<string, Json> };
    expect(JSON.stringify(payRate.properties["rate_minor"])).toContain(
      "#/components/schemas/Masked",
    );
    const create = doc.components["schemas"]?.["PayRateCreate"] as {
      properties: Record<string, Json>;
    };
    expect(JSON.stringify(create.properties["rate_minor"])).not.toContain("Masked");
  });

  it("never accepts org_id in a request body", () => {
    for (const [name, schema] of Object.entries(doc.components["schemas"] ?? {})) {
      if (!name.endsWith("Create") && !name.endsWith("Update")) continue;
      expect(Object.keys((schema["properties"] as Json | undefined) ?? {}), name).not.toContain(
        "org_id",
      );
    }
  });

  it("states record, opportunity, application and engagement states as enums", () => {
    const schemas = doc.components["schemas"] ?? {};
    expect(schemas["RecordState"]?.["enum"]).toHaveLength(9);
    expect(schemas["OpportunityState"]?.["enum"]).toHaveLength(7);
    expect(schemas["ApplicationState"]?.["enum"]).toHaveLength(8);
    expect(schemas["EngagementState"]?.["enum"]).toHaveLength(6);
  });

  it("models canon lists as pattern-validated codes, not enums", () => {
    const schemas = doc.components["schemas"] ?? {};
    for (const id of [
      "DeptCode",
      "DiscCode",
      "Urid",
      "RecordKind",
      "RoleCode",
      "GlAccountCode",
      "CounterpartyType",
    ]) {
      expect(schemas[id]?.["pattern"], id).toBeTruthy();
      expect(schemas[id]?.["enum"], id).toBeUndefined();
    }
  });
});

describe("coverage of the spec", () => {
  const ids = new Set(operations.map((o) => o.op.operationId));

  it.each(SECTION_COVERAGE.map((e) => [`${e.module}: ${e.entity}`, e] as const))(
    "%s",
    (_label, entry) => {
      const missing = entry.operations.filter((id) => !ids.has(id));
      expect(missing).toEqual([]);
    },
  );

  it("covers every Section 4.2 module with at least one operation", () => {
    const tags = new Set(operations.flatMap((o) => o.op.tags ?? []));
    for (const m of MODULES) expect(tags.has(m), m).toBe(true);
  });

  it("serves every catalog resource under its declared path", () => {
    for (const spec of catalog) {
      const has = Object.keys(doc.paths).some(
        (p) => p === spec.path || p.startsWith(`${spec.path}/`),
      );
      expect(has, spec.path).toBe(true);
    }
  });
});
