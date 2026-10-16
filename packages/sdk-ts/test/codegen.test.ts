/** The generator: determinism, coverage, check mode and refusal of unsupported documents. */
import { describe, expect, it } from "vitest";
import type { OpenApiDocument } from "../codegen/ir.ts";
import { buildIR } from "../codegen/ir.ts";
import { generate, loadDocument } from "../codegen/index.ts";
import {
  camelCase,
  pascalCase,
  pythonIdentifier,
  snakeCase,
  tsIdentifier,
  tsPropertyKey,
} from "../codegen/names.ts";
import { emitTypeScript, tsType } from "../codegen/ts-emitter.ts";
import { emitPython } from "../codegen/python-emitter.ts";

const document = loadDocument();

type Mutable = Record<string, unknown>;

function clone(): Mutable {
  return JSON.parse(JSON.stringify(document)) as Mutable;
}

function op(doc: Mutable, path: string, method: string): Mutable {
  const paths = doc["paths"] as Record<string, Record<string, Mutable>>;
  return (paths[path] as Record<string, Mutable>)[method] as Mutable;
}

describe("intermediate representation", () => {
  const ir = buildIR(document);

  it("includes every operation and groups them by resource", () => {
    let count = 0;
    for (const item of Object.values(document.paths)) count += Object.keys(item).length;
    expect(ir.operations).toHaveLength(count);
    expect(ir.resources.reduce((n, r) => n + r.operations.length, 0)).toBe(count);
  });

  it("describes a paged list, an update and a create", () => {
    const list = ir.operations.find((o) => o.id === "projects.list");
    expect(list).toMatchObject({ paged: true, fields: true, item: "Project", method: "GET" });
    const update = ir.operations.find((o) => o.id === "projects.update");
    expect(update).toMatchObject({
      ifMatch: true,
      idempotent: false,
      body: "ProjectUpdate",
      pathParams: [{ name: "id" }],
    });
    const create = ir.operations.find((o) => o.id === "projects.create");
    expect(create).toMatchObject({
      idempotent: true,
      successStatus: 201,
      scopes: ["projects"],
      capability: "projects.project.create",
    });
  });

  it("refuses documents it cannot represent faithfully", () => {
    const refuse = (mutate: (doc: Mutable) => void, message: RegExp) => {
      const doc = clone();
      mutate(doc);
      expect(() => buildIR(doc as unknown as OpenApiDocument)).toThrow(message);
    };
    refuse((d) => (d["openapi"] = "3.0.3"), /3\.1/);
    refuse((d) => (op(d, "/projects", "get")["operationId"] = "projects_list"), /resource/);
    refuse((d) => (op(d, "/projects", "post")["operationId"] = "projects.list"), /Duplicate/);
    refuse(
      (d) =>
        (op(d, "/projects", "post")["requestBody"] = {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        }),
      /inline/,
    );
    refuse(
      (d) =>
        (op(d, "/projects", "get")["parameters"] as unknown[]).push({
          name: "X-Trace",
          in: "header",
          schema: { type: "string" },
        }),
      /header parameter/,
    );
    refuse(
      (d) => delete (op(d, "/calendars/{id}", "delete")["responses"] as Mutable)["204"],
      /no success/,
    );
    refuse((d) => (op(d, "/projects/{id}", "get")["parameters"] = []), /path template/);
    refuse(
      (d) =>
        (op(d, "/projects", "get")["parameters"] as unknown[]).push({
          $ref: "#/components/parameters/Nope",
        }),
      /Missing parameter component/,
    );
  });
});

describe("emitters", () => {
  const ir = buildIR(document);

  it("maps JSON Schema to TypeScript types", () => {
    expect(tsType({ type: ["string", "null"] })).toBe("string | null");
    expect(tsType({ enum: ["A", 1, true] })).toBe('"A" | 1 | true');
    expect(tsType({ type: "array", items: { $ref: "#/components/schemas/Project" } })).toBe(
      "ReadonlyArray<Project>",
    );
    expect(tsType({ type: "array" })).toBe("ReadonlyArray<unknown>");
    expect(
      tsType({ allOf: [{ $ref: "#/components/schemas/RoleCode" }, { type: ["string", "null"] }] }),
    ).toBe("RoleCode | null");
    expect(
      tsType({ allOf: [{ $ref: "#/components/schemas/A" }, { $ref: "#/components/schemas/B" }] }),
    ).toBe("A & B");
    expect(tsType({ anyOf: [{ type: "integer" }, { type: "null" }] })).toBe("number | null");
    expect(tsType({ type: "object" })).toBe("{ readonly [key: string]: unknown }");
    expect(tsType({ type: "object", additionalProperties: { type: "string" } })).toBe(
      "{ readonly [key: string]: string }",
    );
    expect(tsType({})).toBe("unknown");
    expect(tsType({ properties: { a: { type: "boolean" } } })).toContain("readonly a?: boolean;");
    expect(
      tsType({
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: { type: "number" },
      }),
    ).toContain("& { readonly [key: string]: number }");
    expect(() => tsType({ type: "tuple" })).toThrow(/Unsupported/);
    expect(() => tsType({ $ref: "#/definitions/X" })).toThrow(/Unsupported schema reference/);
  });

  it("emits one TypeScript method per operation and one Python method per operation", () => {
    const resources =
      emitTypeScript(ir).find((f) => f.path.endsWith("resources.ts"))?.contents ?? "";
    const python = emitPython(ir).find((f) => f.path.endsWith("resources.py"))?.contents ?? "";
    for (const op of ir.operations) {
      expect(resources).toContain(`$OPERATIONS[${JSON.stringify(op.id)}]`);
      expect(python).toContain(`OPERATIONS[${JSON.stringify(op.id)}]`);
    }
  });

  it("converts names", () => {
    expect(camelCase("purchase-orders")).toBe("purchaseOrders");
    expect(pascalCase("purchaseOrders")).toBe("PurchaseOrders");
    expect(snakeCase("gateReadiness")).toBe("gate_readiness");
    expect(snakeCase("HTTPStatus")).toBe("http_status");
    expect(pythonIdentifier("class")).toBe("class_");
    expect(pythonIdentifier("limit")).toBe("limit_");
    expect(pythonIdentifier("dept_code")).toBe("dept_code");
    expect(tsIdentifier("class")).toBe("classValue");
    expect(tsIdentifier("dept_code")).toBe("deptCode");
    expect(tsPropertyKey("a-b")).toBe('"a-b"');
  });
});

describe("check mode", () => {
  it("reports no drift for the committed TypeScript SDK", async () => {
    const [result] = await generate(["ts"], { check: true });
    expect(result?.drift).toEqual([]);
    expect(result?.files).toHaveLength(4);
  });

  it("reports drift when the document changes", async () => {
    const changed = clone();
    (changed["info"] as Mutable)["version"] = "9.9.9";
    const [result] = await generate(["ts"], {
      check: true,
      document: changed as unknown as OpenApiDocument,
    });
    expect(result?.drift).toContain("packages/sdk-ts/src/generated/operations.ts");
  });
});
