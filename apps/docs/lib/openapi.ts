/**
 * The API reference model, built from packages/api/openapi/v1.json at build time. Nothing here
 * is written by hand: summaries, descriptions, fields, constraints and examples all come from
 * the document, so the reference always matches the contract (Section 10.1).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "./content.ts";

type Schema = {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly items?: Schema;
  readonly additionalProperties?: boolean | Schema;
  readonly allOf?: readonly Schema[];
  readonly anyOf?: readonly Schema[];
  readonly oneOf?: readonly Schema[];
  readonly example?: unknown;
  readonly [keyword: string]: unknown;
};

interface Parameter {
  readonly $ref?: string;
  readonly name: string;
  readonly in: string;
  readonly required?: boolean;
  readonly description?: string;
  readonly schema?: Schema;
}

interface Response {
  readonly $ref?: string;
  readonly description?: string;
  readonly content?: Readonly<
    Record<string, { readonly schema?: Schema; readonly example?: unknown }>
  >;
}

interface Operation {
  readonly operationId: string;
  readonly tags?: readonly string[];
  readonly summary?: string;
  readonly description?: string;
  readonly parameters?: readonly Parameter[];
  readonly requestBody?: {
    readonly content: Readonly<Record<string, { readonly schema?: Schema }>>;
  };
  readonly responses: Readonly<Record<string, Response>>;
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
  readonly "x-xos-capability"?: string;
}

interface Doc {
  readonly info: { readonly version: string; readonly title: string };
  readonly tags: readonly { readonly name: string; readonly description: string }[];
  readonly paths: Readonly<Record<string, Readonly<Record<string, Operation>>>>;
  readonly components: {
    readonly schemas: Readonly<Record<string, Schema>>;
    readonly parameters: Readonly<Record<string, Parameter>>;
    readonly responses: Readonly<Record<string, Response>>;
  };
}

export const DOCUMENT_FILE = join(APP_DIR, "..", "..", "packages", "api", "openapi", "v1.json");

export interface FieldRow {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
  readonly constraints: string;
}

export interface Shape {
  readonly name: string;
  readonly description: string;
  readonly fields: readonly FieldRow[];
}

export interface OperationDoc {
  readonly id: string;
  readonly resource: string;
  readonly verb: string;
  readonly method: string;
  readonly path: string;
  readonly summary: string;
  readonly description: string;
  readonly capability: string | null;
  readonly scopes: readonly string[];
  readonly pathParams: readonly FieldRow[];
  readonly queryParams: readonly FieldRow[];
  readonly paged: boolean;
  readonly idempotent: boolean;
  readonly ifMatch: boolean;
  readonly body: Shape | null;
  readonly successStatus: number;
  readonly response: Shape | null;
  readonly errorStatuses: readonly number[];
  readonly requestExample: unknown;
  readonly responseExample: unknown;
  readonly samples: {
    readonly curl: string;
    readonly typescript: string;
    readonly python: string;
    readonly cli: string;
  };
}

export interface ResourceDoc {
  readonly name: string;
  readonly slug: string;
  readonly tag: string;
  readonly operations: readonly OperationDoc[];
}

export interface Reference {
  readonly version: string;
  readonly title: string;
  readonly tags: readonly { readonly name: string; readonly description: string }[];
  readonly resources: readonly ResourceDoc[];
  readonly operationCount: number;
}

const HTTP_METHODS = ["get", "post", "patch", "put", "delete"];

export function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function snake(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function refName(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

class Builder {
  readonly #doc: Doc;
  constructor(doc: Doc) {
    this.#doc = doc;
  }

  resolve(s: Schema): Schema {
    let current = s;
    for (let i = 0; current.$ref && i < 16; i++)
      current = this.#doc.components.schemas[refName(current.$ref)] ?? {};
    return current;
  }

  typeLabel(s: Schema): string {
    if (s.$ref) return refName(s.$ref);
    if (s.allOf) {
      const nullable = s.allOf.some(
        (m) => Array.isArray(m.type) && m.type.includes("null") && !m.$ref,
      );
      const inner =
        s.allOf
          .filter((m) => m.$ref)
          .map((m) => this.typeLabel(m))
          .join(" & ") || "object";
      return nullable ? `${inner} | null` : inner;
    }
    const union = s.anyOf ?? s.oneOf;
    if (union) return [...new Set(union.map((m) => this.typeLabel(m)))].join(" | ");
    if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
    const types =
      s.type === undefined ? ["object"] : Array.isArray(s.type) ? s.type : [s.type as string];
    return types
      .map((t) => {
        if (t === "array") return `array of ${s.items ? this.typeLabel(s.items) : "values"}`;
        if (t === "string" && s.format) return `string (${s.format})`;
        if (t === "integer" && s.format === "int64") return "integer (int64)";
        return t;
      })
      .join(" | ");
  }

  constraints(s: Schema): string {
    const r = this.resolve(s);
    const parts: string[] = [];
    if (typeof r["pattern"] === "string") parts.push(`pattern ${r["pattern"]}`);
    if (typeof r["minLength"] === "number" || typeof r["maxLength"] === "number") {
      parts.push(`length ${r["minLength"] ?? 0} to ${r["maxLength"] ?? "any"}`);
    }
    if (typeof r["minimum"] === "number" || typeof r["maximum"] === "number") {
      parts.push(`range ${r["minimum"] ?? "any"} to ${r["maximum"] ?? "any"}`);
    }
    if (r.enum && s.$ref) parts.push(`one of ${r.enum.map((v) => JSON.stringify(v)).join(", ")}`);
    return parts.join("; ");
  }

  shape(name: string): Shape {
    const s = this.resolve({ $ref: `#/components/schemas/${name}` });
    const required = new Set(s.required ?? []);
    const fields = Object.entries(s.properties ?? {}).map(([field, prop]) => ({
      name: field,
      type: this.typeLabel(prop),
      required: required.has(field),
      description: prop.description ?? this.resolve(prop).description ?? "",
      constraints: this.constraints(prop),
    }));
    return { name, description: s.description ?? "", fields };
  }

  example(s: Schema, depth = 0): unknown {
    if (depth > 6) return null;
    if (s.example !== undefined) return s.example;
    if (s.$ref) return this.example(this.resolve(s), depth + 1);
    if (s.allOf) {
      const concrete = s.allOf.find((m) => m.$ref);
      return concrete ? this.example(concrete, depth + 1) : null;
    }
    const union = s.anyOf ?? s.oneOf;
    if (union) return this.example(union[0] ?? {}, depth + 1);
    if (s.enum) return s.enum[0];
    if (s.properties) {
      return Object.fromEntries(
        Object.entries(s.properties).map(([k, v]) => [k, this.example(v, depth + 1)]),
      );
    }
    const type = Array.isArray(s.type) ? s.type[0] : s.type;
    if (type === "array") return s.items ? [this.example(s.items, depth + 1)] : [];
    if (type === "integer" || type === "number") return 1;
    if (type === "boolean") return true;
    return type === "string" ? "" : null;
  }

  /** A request body from the document's examples: required members, plus optional ones that have an example. */
  bodyExample(name: string): unknown {
    const s = this.resolve({ $ref: `#/components/schemas/${name}` });
    const required = new Set(s.required ?? []);
    return Object.fromEntries(
      Object.entries(s.properties ?? {})
        .filter(([k, v]) => required.has(k) || v.example !== undefined)
        .map(([k, v]) => [k, this.example(v)]),
    );
  }

  param(p: Parameter): { shared: string | null; p: Parameter } {
    if (!p.$ref) return { shared: null, p };
    const name = refName(p.$ref);
    return { shared: name, p: this.#doc.components.parameters[name] as Parameter };
  }

  response(r: Response): Response {
    return r.$ref ? (this.#doc.components.responses[refName(r.$ref)] as Response) : r;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function pythonLiteral(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(", ")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${JSON.stringify(k)}: ${pythonLiteral(v)}`)
    .join(", ")}}`;
}

function samples(
  op: Omit<OperationDoc, "samples">,
  pathValues: readonly string[],
): OperationDoc["samples"] {
  const path = op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const i = op.pathParams.findIndex((p) => p.name === name);
    return encodeURIComponent(pathValues[i] ?? name);
  });
  const body = op.body ? JSON.stringify(op.requestExample) : null;
  const curl = [
    `curl -X ${op.method} "$XOS_BASE_URL${path}"`,
    `  -H "Authorization: Bearer $XOS_API_KEY"`,
    ...(op.idempotent ? [`  -H "Idempotency-Key: $(uuidgen)"`] : []),
    ...(op.ifMatch ? [`  -H 'If-Match: W/"etag-from-your-last-read"'`] : []),
    ...(body ? [`  -H "Content-Type: application/json"`, `  -d '${body}'`] : []),
  ].join(" \\\n");
  const args = pathValues.map((v) => JSON.stringify(v));
  const camelResource = op.resource;
  const tsArgs = [...args, ...(body ? [json(op.requestExample).replace(/\n/g, "\n  ")] : [])];
  const tsMethod = op.verb;
  const typescript = op.paged
    ? `for await (const row of xos.${camelResource}.${tsMethod}All(${args.join(", ")})) {\n  console.log(row);\n}`
    : `const { data${op.ifMatch || op.verb === "get" ? ", etag" : ""} } = await xos.${camelResource}.${tsMethod}(${[...tsArgs, ...(op.ifMatch ? ["{ ifMatch: etag }"] : [])].join(", ")});`;
  const pyArgs = [
    ...args,
    ...(body ? [pythonLiteral(op.requestExample)] : []),
    ...(op.ifMatch ? ["if_match=etag"] : []),
  ];
  const python = op.paged
    ? `for row in xos.${snake(camelResource)}.${snake(op.verb)}_all(${args.join(", ")}):\n    print(row)`
    : `response = xos.${snake(camelResource)}.${snake(op.verb)}(${pyArgs.join(", ")})`;
  const cli = [
    `xos ${kebab(camelResource)} ${kebab(op.verb)}${pathValues.length ? ` ${pathValues.join(" ")}` : ""}`,
    ...(op.paged ? [" --all"] : []),
    ...(body ? [` --data '${body}'`] : []),
    ...(op.ifMatch ? [" --if-match auto"] : []),
  ].join("");
  return { curl, typescript, python, cli };
}

let reference: Reference | null = null;

export function loadReference(file: string = DOCUMENT_FILE): Reference {
  if (reference && file === DOCUMENT_FILE) return reference;
  const doc = JSON.parse(readFileSync(file, "utf8")) as Doc;
  const b = new Builder(doc);
  const byResource = new Map<string, OperationDoc[]>();
  const tagOf = new Map<string, string>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      const [resource, verb] = op.operationId.split(".") as [string, string];
      const params = (op.parameters ?? []).map((p) => b.param(p));
      const shared = new Set(params.map((p) => p.shared).filter(Boolean));
      const row = (p: Parameter): FieldRow => ({
        name: p.name,
        type: p.schema ? b.typeLabel(p.schema) : "string",
        required: p.required === true,
        description: p.description ?? "",
        constraints: p.schema ? b.constraints(p.schema) : "",
      });
      const order = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const pathParams = params
        .filter((x) => x.p.in === "path")
        .map((x) => x.p)
        .sort((x, y) => order.indexOf(x.name) - order.indexOf(y.name));
      const queryParams = params.filter((x) => x.p.in === "query").map((x) => row(x.p));
      const successStatus =
        Object.keys(op.responses)
          .map(Number)
          .filter((s) => s >= 200 && s < 300)
          .sort()[0] ?? 200;
      const success = b.response(op.responses[String(successStatus)] as Response);
      const media = success.content?.["application/json"];
      const responseName = media?.schema?.$ref ? refName(media.schema.$ref) : null;
      const bodyRef = op.requestBody?.content["application/json"]?.schema?.$ref;
      const bodyName = bodyRef ? refName(bodyRef) : null;
      const paged = shared.has("Cursor");
      const itemName =
        paged && responseName
          ? (b.resolve({ $ref: `#/components/schemas/${responseName}` }).properties?.["data"]?.items
              ?.$ref ?? null)
          : null;
      const scopes = new Set<string>();
      for (const s of op.security ?? []) for (const scope of s["oauth2"] ?? []) scopes.add(scope);
      const base: Omit<OperationDoc, "samples"> = {
        id: op.operationId,
        resource,
        verb,
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? op.operationId,
        description: op.description ?? "",
        capability: op["x-xos-capability"] ?? null,
        scopes: [...scopes].sort(),
        pathParams: pathParams.map(row),
        queryParams,
        paged,
        idempotent: shared.has("IdempotencyKey"),
        ifMatch: shared.has("IfMatch"),
        body: bodyName ? b.shape(bodyName) : null,
        successStatus,
        response: responseName ? b.shape(itemName ? refName(itemName) : responseName) : null,
        errorStatuses: Object.keys(op.responses)
          .map(Number)
          .filter((s) => s >= 400)
          .sort((x, y) => x - y),
        requestExample: bodyName ? b.bodyExample(bodyName) : null,
        responseExample:
          media?.example ??
          (responseName ? b.example({ $ref: `#/components/schemas/${responseName}` }) : null),
      };
      const pathValues = pathParams.map((p) => String(p.schema ? b.example(p.schema) : p.name));
      const list = byResource.get(resource) ?? [];
      list.push({ ...base, samples: samples(base, pathValues) });
      byResource.set(resource, list);
      if (!tagOf.has(resource)) tagOf.set(resource, op.tags?.[0] ?? "General");
    }
  }
  const resources = [...byResource.entries()].map(([name, operations]) => ({
    name,
    slug: kebab(name),
    tag: tagOf.get(name) as string,
    operations,
  }));
  const built: Reference = {
    version: doc.info.version,
    title: doc.info.title,
    tags: doc.tags,
    resources,
    operationCount: resources.reduce((n, r) => n + r.operations.length, 0),
  };
  if (file === DOCUMENT_FILE) reference = built;
  return built;
}

export function findResource(slug: string): ResourceDoc | undefined {
  return loadReference().resources.find((r) => r.slug === slug);
}
