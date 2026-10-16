/**
 * Intermediate representation of the OpenAPI v1 document for the SDK generators.
 *
 * Both the TypeScript and the Python emitters read this model, so the two SDKs always cover
 * the same operations with the same parameters. The model is built only from the document;
 * nothing here knows about a particular resource.
 */

export type JsonSchema = {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly allOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly [keyword: string]: unknown;
};

type Parameter = {
  readonly $ref?: string;
  readonly name: string;
  readonly in: "path" | "query" | "header" | "cookie";
  readonly required?: boolean;
  readonly description?: string;
  readonly schema?: JsonSchema;
};

type MediaType = { readonly schema?: JsonSchema };
type Response = {
  readonly $ref?: string;
  readonly description?: string;
  readonly content?: Readonly<Record<string, MediaType>>;
};

type Operation = {
  readonly operationId: string;
  readonly tags?: readonly string[];
  readonly summary?: string;
  readonly description?: string;
  readonly parameters?: readonly Parameter[];
  readonly requestBody?: {
    readonly required?: boolean;
    readonly content: Readonly<Record<string, MediaType>>;
  };
  readonly responses: Readonly<Record<string, Response>>;
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
  readonly "x-xos-capability"?: string;
  readonly "x-xos-table"?: string;
};

export type OpenApiDocument = {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly tags?: readonly { readonly name: string; readonly description?: string }[];
  readonly paths: Readonly<Record<string, Readonly<Record<string, Operation>>>>;
  readonly components: {
    readonly schemas: Readonly<Record<string, JsonSchema>>;
    readonly parameters?: Readonly<Record<string, Parameter>>;
    readonly responses?: Readonly<Record<string, Response>>;
  };
};

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ParamIR {
  /** Name on the wire. */
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
  readonly schema: JsonSchema;
}

export interface OperationIR {
  /** `{resource}.{verb}` (ADR 0003). */
  readonly id: string;
  readonly resource: string;
  readonly verb: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly tag: string;
  readonly summary: string;
  readonly description: string;
  readonly capability: string | null;
  readonly table: string | null;
  readonly scopes: readonly string[];
  /** Path parameters in the order they appear in the path template. */
  readonly pathParams: readonly ParamIR[];
  /** Query parameters other than the shared pagination, fieldset, sort and filter ones. */
  readonly queryParams: readonly ParamIR[];
  /** Cursor-paginated list with `limit`, `cursor`, `sort` and `filter`. */
  readonly paged: boolean;
  /** Accepts the sparse fieldset parameter `fields`. */
  readonly fields: boolean;
  /** Requires `Idempotency-Key`. */
  readonly idempotent: boolean;
  /** Requires `If-Match`. */
  readonly ifMatch: boolean;
  /** Component schema name of the JSON request body, or null when the operation takes none. */
  readonly body: string | null;
  readonly bodyRequired: boolean;
  /** The documented success status. */
  readonly successStatus: number;
  /** Component schema name of the success body, or null for an empty body. */
  readonly response: string | null;
  /** For a paged list, the component schema name of one item. */
  readonly item: string | null;
}

export interface ResourceIR {
  readonly name: string;
  readonly tag: string;
  readonly operations: readonly OperationIR[];
}

export interface SchemaIR {
  readonly name: string;
  readonly schema: JsonSchema;
}

export interface ApiIR {
  readonly title: string;
  readonly version: string;
  readonly tags: readonly { readonly name: string; readonly description: string }[];
  readonly schemas: readonly SchemaIR[];
  readonly resources: readonly ResourceIR[];
  readonly operations: readonly OperationIR[];
}

const METHODS: readonly HttpMethod[] = ["GET", "POST", "PATCH", "PUT", "DELETE"];
const SHARED_QUERY = new Set(["Limit", "Cursor", "Fields", "Sort", "Filter"]);
const OPERATION_ID = /^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/;
const JSON_MEDIA = "application/json";

export function refName(ref: string): string {
  const prefix = "#/components/schemas/";
  if (!ref.startsWith(prefix)) throw new Error(`Unsupported schema reference ${ref}`);
  return ref.slice(prefix.length);
}

function componentName(ref: string, kind: "parameters" | "responses"): string {
  const prefix = `#/components/${kind}/`;
  if (!ref.startsWith(prefix)) throw new Error(`Unsupported ${kind} reference ${ref}`);
  return ref.slice(prefix.length);
}

function resolveParameter(
  doc: OpenApiDocument,
  p: Parameter,
): { shared: string | null; p: Parameter } {
  if (!p.$ref) return { shared: null, p };
  const name = componentName(p.$ref, "parameters");
  const resolved = doc.components.parameters?.[name];
  if (!resolved) throw new Error(`Missing parameter component ${name}`);
  return { shared: name, p: resolved };
}

function resolveResponse(doc: OpenApiDocument, r: Response): Response {
  if (!r.$ref) return r;
  const name = componentName(r.$ref, "responses");
  const resolved = doc.components.responses?.[name];
  if (!resolved) throw new Error(`Missing response component ${name}`);
  return resolved;
}

function jsonSchemaName(media: Readonly<Record<string, MediaType>> | undefined, where: string) {
  const schema = media?.[JSON_MEDIA]?.schema;
  if (!schema) return null;
  if (!schema.$ref) throw new Error(`${where}: inline schemas are not supported; use a component`);
  return refName(schema.$ref);
}

function toParam(p: Parameter): ParamIR {
  return {
    name: p.name,
    required: p.required === true,
    description: p.description ?? p.schema?.description ?? "",
    schema: p.schema ?? { type: "string" },
  };
}

function buildOperation(
  doc: OpenApiDocument,
  path: string,
  method: HttpMethod,
  op: Operation,
): OperationIR {
  if (!OPERATION_ID.test(op.operationId)) {
    throw new Error(`Operation id ${op.operationId} is not {resource}.{verb}`);
  }
  const [resource, verb] = op.operationId.split(".") as [string, string];
  const shared = new Set<string>();
  const pathParams: ParamIR[] = [];
  const queryParams: ParamIR[] = [];
  for (const raw of op.parameters ?? []) {
    const { shared: sharedName, p } = resolveParameter(doc, raw);
    if (sharedName) shared.add(sharedName);
    if (sharedName && (SHARED_QUERY.has(sharedName) || p.in === "header")) continue;
    if (p.in === "path") pathParams.push(toParam(p));
    else if (p.in === "query") queryParams.push(toParam(p));
    else if (p.in === "header") {
      throw new Error(`${op.operationId}: header parameter ${p.name} is not a shared convention`);
    }
  }
  const order = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  pathParams.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  if (pathParams.length !== order.length) {
    throw new Error(`${op.operationId}: path template and path parameters disagree`);
  }

  const successes = Object.keys(op.responses)
    .map(Number)
    .filter((s) => s >= 200 && s < 300)
    .sort((a, b) => a - b);
  const successStatus = successes[0];
  if (successStatus === undefined) throw new Error(`${op.operationId}: no success response`);
  const success = resolveResponse(doc, op.responses[String(successStatus)] as Response);
  const response = jsonSchemaName(success.content, `${op.operationId} response`);

  const paged = shared.has("Cursor");
  let item: string | null = null;
  if (paged) {
    const page = response ? doc.components.schemas[response] : undefined;
    const items = page?.properties?.["data"]?.items;
    if (!items?.$ref || !page?.properties?.["next_cursor"]) {
      throw new Error(`${op.operationId}: a paged list must return { data, next_cursor }`);
    }
    item = refName(items.$ref);
  }

  const scopes = new Set<string>();
  for (const requirement of op.security ?? []) {
    for (const s of requirement["oauth2"] ?? []) scopes.add(s);
  }

  return {
    id: op.operationId,
    resource,
    verb,
    method,
    path,
    tag: op.tags?.[0] ?? "General",
    summary: op.summary ?? op.operationId,
    description: op.description ?? "",
    capability: op["x-xos-capability"] ?? null,
    table: op["x-xos-table"] ?? null,
    scopes: [...scopes].sort(),
    pathParams,
    queryParams,
    paged,
    fields: shared.has("Fields"),
    idempotent: shared.has("IdempotencyKey"),
    ifMatch: shared.has("IfMatch"),
    body: op.requestBody ? jsonSchemaName(op.requestBody.content, `${op.operationId} body`) : null,
    bodyRequired: op.requestBody?.required === true,
    successStatus,
    response,
    item,
  };
}

/** Builds the model. Throws on any construct the generators cannot represent faithfully. */
export function buildIR(doc: OpenApiDocument): ApiIR {
  if (!doc.openapi.startsWith("3.1")) throw new Error(`Expected OpenAPI 3.1, got ${doc.openapi}`);
  const operations: OperationIR[] = [];
  const seen = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [key, op] of Object.entries(item)) {
      const method = key.toUpperCase() as HttpMethod;
      if (!METHODS.includes(method)) continue;
      if (seen.has(op.operationId)) throw new Error(`Duplicate operation id ${op.operationId}`);
      seen.add(op.operationId);
      operations.push(buildOperation(doc, path, method, op));
    }
  }
  const byResource = new Map<string, OperationIR[]>();
  for (const op of operations) {
    const list = byResource.get(op.resource) ?? [];
    list.push(op);
    byResource.set(op.resource, list);
  }
  const resources: ResourceIR[] = [...byResource.entries()].map(([name, ops]) => ({
    name,
    tag: ops[0]?.tag ?? "General",
    operations: ops,
  }));
  const schemas = Object.entries(doc.components.schemas).map(([name, schema]) => ({
    name,
    schema,
  }));
  return {
    title: doc.info.title,
    version: doc.info.version,
    tags: (doc.tags ?? []).map((t) => ({ name: t.name, description: t.description ?? "" })),
    schemas,
    resources,
    operations,
  };
}
