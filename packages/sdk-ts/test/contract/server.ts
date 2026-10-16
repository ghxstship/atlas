/**
 * Contract test server: an in-memory HTTP implementation of every operation in the OpenAPI
 * v1 document, driven only by the document. It enforces the ADR 0003 conventions (bearer
 * authentication, Idempotency-Key with replay, If-Match with ETag, cursor pagination, the
 * filter grammar, sparse fieldsets, compare-and-set transitions, RFC 9457 problems) and
 * validates every request body and every response body against the schemas.
 *
 * The SDKs, the CLI and the MCP server run their tests against it until the API runtime is
 * live; the same tests can point at a real deployment by changing the base URL.
 */
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenApiDocument, OperationIR } from "../../codegen/ir.ts";
import { buildIR } from "../../codegen/ir.ts";
import { loadDocument } from "../../codegen/index.ts";
import type { Schema } from "./schema.ts";
import { SchemaSet } from "./schema.ts";

export const CONTRACT_API_KEY = "xos_test_contract_key";

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: unknown;
  readonly operationId: string | null;
}

export interface InjectedResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface ContractServer {
  /** Base URL including `/api/v1`. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly requests: RecordedRequest[];
  /** Responses that did not validate against the document. Tests assert this stays empty. */
  readonly violations: string[];
  readonly operations: readonly OperationIR[];
  /** Answers the next request with this response instead of handling it. */
  failNext(response: InjectedResponse): void;
  /** Puts a row into a collection, for example `seed("/projects", { id, ... })`. */
  seed(collection: string, row: Record<string, unknown>): void;
  rows(collection: string): Record<string, unknown>[];
  close(): Promise<void>;
}

export interface ContractServerOptions {
  readonly document?: OpenApiDocument;
  readonly apiKey?: string;
  /**
   * When a row addressed by path is not in memory, answer with a row built from the
   * document's examples instead of 404. Used to exercise every operation without seeding.
   */
  readonly seedOnMiss?: boolean;
}

interface Route {
  readonly op: OperationIR;
  readonly regex: RegExp;
  readonly params: readonly string[];
  /** Collection path the operation acts on, for example `/projects`. */
  readonly collection: string;
  /** Path parameter that names a row in the collection, or null for collection-level operations. */
  readonly key: string | null;
  readonly literalSegments: number;
}

interface Row {
  value: Record<string, unknown>;
  version: number;
}

class HttpProblem extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(
    status: number,
    slug: string,
    title: string,
    detail: string,
    extra: Record<string, unknown> = {},
  ) {
    super(detail);
    this.status = status;
    this.body = { type: `/problems/${slug}`, title, status, detail, ...extra };
  }
}

function compileRoute(op: OperationIR): Route {
  const params: string[] = [];
  const pattern = op.path
    .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
    .replace(/\{([^}]+)\}/g, (_m, name: string) => {
      params.push(name);
      return "([^/]+)";
    });
  const segments = op.path.split("/").filter(Boolean);
  let collection = op.path;
  let key: string | null = null;
  const last = segments[segments.length - 1] ?? "";
  const beforeLast = segments[segments.length - 2] ?? "";
  if (/^\{.+\}$/.test(last)) {
    key = last.slice(1, -1);
    collection = `/${segments.slice(0, -1).join("/")}`;
  } else if (/^\{.+\}$/.test(beforeLast)) {
    key = beforeLast.slice(1, -1);
    collection = `/${segments.slice(0, -2).join("/")}`;
  }
  return {
    op,
    regex: new RegExp(`^${pattern}$`),
    params,
    collection,
    key,
    literalSegments: segments.filter((s) => !s.startsWith("{")).length,
  };
}

function etagOf(row: Row): string {
  return `W/"${createHash("sha1")
    .update(`${row.version}:${JSON.stringify(row.value)}`)
    .digest("hex")
    .slice(0, 16)}"`;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown };
    if (typeof parsed.o === "number" && Number.isInteger(parsed.o) && parsed.o >= 0)
      return parsed.o;
  } catch (error) {
    throw new HttpProblem(
      400,
      "invalid-cursor",
      "Bad Request",
      `The cursor is not one this API issued (${String(error)}).`,
    );
  }
  throw new HttpProblem(
    400,
    "invalid-cursor",
    "Bad Request",
    "The cursor is not one this API issued.",
  );
}

const FILTER_KEY = /^filter\[([a-z_][a-z0-9_]*)\]\[([a-z_]+)\]$/;
const OPERATORS = new Set(["eq", "ne", "lt", "lte", "gt", "gte", "in", "is_null", "contains"]);

function compare(a: unknown, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (typeof a === "number" && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(b);
}

function matchesFilter(
  row: Record<string, unknown>,
  field: string,
  op: string,
  value: string,
): boolean {
  const v = row[field];
  switch (op) {
    case "eq":
      return v !== null && v !== undefined && String(v) === value;
    case "ne":
      return String(v) !== value;
    case "in":
      return value.split(",").includes(String(v));
    case "is_null":
      return (v === null || v === undefined) === (value === "true");
    case "contains":
      return typeof v === "string" && v.toLowerCase().includes(value.toLowerCase());
    case "lt":
      return v !== null && v !== undefined && compare(v, value) < 0;
    case "lte":
      return v !== null && v !== undefined && compare(v, value) <= 0;
    case "gt":
      return v !== null && v !== undefined && compare(v, value) > 0;
    case "gte":
      return v !== null && v !== undefined && compare(v, value) >= 0;
    default:
      return false;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startContractServer(
  options: ContractServerOptions = {},
): Promise<ContractServer> {
  const document = options.document ?? loadDocument();
  const ir = buildIR(document);
  const schemas = new SchemaSet(document.components.schemas as Record<string, Schema>);
  const apiKey = options.apiKey ?? CONTRACT_API_KEY;
  const routes = ir.operations
    .map(compileRoute)
    .sort((a, b) => b.literalSegments - a.literalSegments || a.params.length - b.params.length);
  const store = new Map<string, Map<string, Row>>();
  const idempotency = new Map<
    string,
    { hash: string; status: number; headers: Record<string, string>; body: unknown }
  >();
  const injected: InjectedResponse[] = [];
  const requests: RecordedRequest[] = [];
  const violations: string[] = [];

  const collectionOf = (path: string) => {
    let rows = store.get(path);
    if (!rows) {
      rows = new Map();
      store.set(path, rows);
    }
    return rows;
  };

  const keyField = (route: Route) => route.key ?? "id";

  const itemSchemaName = (route: Route): string | null => {
    const op = route.op;
    if (op.item) return op.item;
    const sibling = routes.find(
      (r) => r.collection === route.collection && r.op.verb === "get" && r.op.response,
    );
    return sibling?.op.response ?? op.response;
  };

  const synthesizeRow = (route: Route, keyValue: string | null): Row => {
    const name = itemSchemaName(route);
    const value = (name ? schemas.example(schemas.component(name)) : {}) as Record<string, unknown>;
    if (keyValue !== null) {
      const field = keyField(route);
      const prop = name ? schemas.resolve(schemas.component(name)).properties?.[field] : undefined;
      const numeric = prop && (prop.type === "integer" || prop.type === "number");
      value[field] = numeric ? Number(keyValue) : keyValue;
    }
    return { value, version: 1 };
  };

  const findRow = (route: Route, keyValue: string): Row => {
    const rows = collectionOf(route.collection);
    let row = rows.get(keyValue);
    if (!row && options.seedOnMiss) {
      row = synthesizeRow(route, keyValue);
      rows.set(keyValue, row);
    }
    if (!row) {
      throw new HttpProblem(
        404,
        "not-found",
        "Not Found",
        `No row with this identifier is visible to you.`,
      );
    }
    return row;
  };

  const validateQuery = (op: OperationIR, query: URLSearchParams) => {
    const allowed = new Set(op.queryParams.map((p) => p.name));
    for (const p of op.queryParams) {
      if (p.required && !query.has(p.name)) {
        throw new HttpProblem(
          400,
          "missing-parameter",
          "Bad Request",
          `The query parameter ${p.name} is required.`,
        );
      }
    }
    for (const [name, value] of query) {
      const filter = FILTER_KEY.exec(name);
      if (filter && op.paged) {
        if (!OPERATORS.has(filter[2] as string)) {
          throw new HttpProblem(
            400,
            "invalid-filter",
            "Bad Request",
            `Unknown filter operator ${filter[2]}.`,
          );
        }
        continue;
      }
      if (op.paged && name === "limit") {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 200) {
          throw new HttpProblem(
            400,
            "invalid-limit",
            "Bad Request",
            "limit must be an integer from 1 to 200.",
          );
        }
        continue;
      }
      if (op.paged && (name === "cursor" || name === "sort")) continue;
      if (op.fields && name === "fields") continue;
      if (allowed.has(name)) {
        const param = op.queryParams.find((p) => p.name === name) as { schema: Schema };
        const asNumber = Number(value);
        const typed =
          (param.schema.type === "number" || param.schema.type === "integer") &&
          Number.isFinite(asNumber)
            ? asNumber
            : value;
        const errors = schemas.validate(param.schema, typed, `/${name}`);
        if (errors.length > 0) {
          throw new HttpProblem(
            400,
            "invalid-parameter",
            "Bad Request",
            `${name} ${errors[0]?.detail}.`,
          );
        }
        continue;
      }
      throw new HttpProblem(
        400,
        "unknown-parameter",
        "Bad Request",
        `${op.id} has no query parameter ${name}.`,
      );
    }
  };

  const applyFields = (
    row: Record<string, unknown>,
    fields: string | null,
  ): Record<string, unknown> => {
    if (!fields) return row;
    const keep = new Set(["id", ...fields.split(",")]);
    return Object.fromEntries(Object.entries(row).filter(([k]) => keep.has(k)));
  };

  const stateField = (row: Record<string, unknown>): string | null =>
    Object.keys(row).find((k) => k.endsWith("_state")) ?? ("state" in row ? "state" : null);

  function handle(
    route: Route,
    params: Record<string, string>,
    query: URLSearchParams,
    body: unknown,
    headers: IncomingMessage["headers"],
  ): { status: number; body: unknown; headers: Record<string, string> } {
    const op = route.op;
    const keyValue = route.key ? (params[route.key] as string) : null;
    const out: Record<string, string> = {};
    const fields = query.get("fields");

    if (op.method === "GET" && op.paged) {
      let rows = [...collectionOf(route.collection).values()].map((r) => r.value);
      for (const [name, value] of query) {
        const f = FILTER_KEY.exec(name);
        if (f) rows = rows.filter((r) => matchesFilter(r, f[1] as string, f[2] as string, value));
      }
      const sort = query.get("sort");
      if (sort) {
        const keys = sort.split(",");
        rows = [...rows].sort((a, b) => {
          for (const k of keys) {
            const desc = k.startsWith("-");
            const field = desc ? k.slice(1) : k;
            const c = String(a[field] ?? "").localeCompare(String(b[field] ?? ""));
            if (c !== 0) return desc ? -c : c;
          }
          return 0;
        });
      }
      const limit = Number(query.get("limit") ?? 50);
      const cursor = query.get("cursor");
      const offset = cursor ? decodeCursor(cursor) : 0;
      const page = rows.slice(offset, offset + limit).map((r) => applyFields(r, fields));
      const next = offset + limit < rows.length ? encodeCursor(offset + limit) : null;
      return { status: 200, body: { data: page, next_cursor: next }, headers: out };
    }

    if (op.method === "GET") {
      const isRowRead = keyValue !== null && route.op.path === `${route.collection}/{${route.key}}`;
      if (isRowRead) {
        const row = findRow(route, keyValue);
        out["ETag"] = etagOf(row);
        return { status: 200, body: applyFields(row.value, fields), headers: out };
      }
      if (keyValue !== null) findRow(route, keyValue);
      const data = op.response ? schemas.example(schemas.component(op.response)) : undefined;
      return { status: op.successStatus, body: data, headers: out };
    }

    if (op.method === "PATCH") {
      const row = findRow(route, keyValue as string);
      const ifMatch = headers["if-match"];
      if (!ifMatch)
        throw new HttpProblem(
          428,
          "precondition-required",
          "Precondition Required",
          "Send If-Match with the ETag you read.",
        );
      if (ifMatch !== etagOf(row))
        throw new HttpProblem(
          412,
          "precondition-failed",
          "Precondition Failed",
          "The row changed since you read it.",
        );
      row.value = {
        ...row.value,
        ...(body as Record<string, unknown>),
        updated_at: new Date().toISOString(),
      };
      row.version += 1;
      out["ETag"] = etagOf(row);
      return { status: 200, body: row.value, headers: out };
    }

    if (op.method === "DELETE") {
      findRow(route, keyValue as string);
      collectionOf(route.collection).delete(keyValue as string);
      return { status: 204, body: undefined, headers: out };
    }

    // POST
    if (op.verb === "create" && keyValue === null) {
      const row = synthesizeRow(route, null);
      const id = randomUUID();
      row.value = { ...row.value, ...(body as Record<string, unknown>), [keyField(route)]: id };
      if ("id" in row.value) row.value["id"] = id;
      collectionOf(route.collection).set(String(row.value[keyField(route)]), row);
      out["ETag"] = etagOf(row);
      return {
        status: op.successStatus,
        body:
          op.response === itemSchemaName(route)
            ? row.value
            : schemas.example(schemas.component(op.response as string)),
        headers: out,
      };
    }
    if (keyValue !== null) {
      const row = findRow(route, keyValue);
      if (op.verb === "transition") {
        const request = body as { expected_state: string; to_state: string };
        const field = stateField(row.value);
        if (field && row.value[field] !== request.expected_state) {
          throw new HttpProblem(
            422,
            "refusal",
            "Unprocessable Content",
            "The row is not in the expected state.",
            {
              refusal: "REFUSE",
              reason: `The row is ${String(row.value[field])}, not ${request.expected_state}.`,
            },
          );
        }
        if (field) row.value[field] = request.to_state;
        row.version += 1;
      }
      out["ETag"] = etagOf(row);
      if (op.response && op.response === itemSchemaName(route)) {
        return { status: op.successStatus, body: row.value, headers: out };
      }
    }
    const data = op.response ? schemas.example(schemas.component(op.response)) : undefined;
    return { status: op.successStatus, body: data, headers: out };
  }

  const checkResponse = (
    op: OperationIR | null,
    status: number,
    body: unknown,
    fields: string | null,
  ) => {
    if (!op) return;
    if (status >= 400) {
      const errors = schemas.validate(schemas.component("Problem"), body);
      if (errors.length > 0)
        violations.push(`${op.id} ${status}: problem body ${JSON.stringify(errors)}`);
      return;
    }
    if (status !== op.successStatus)
      violations.push(`${op.id}: answered ${status}, documented ${op.successStatus}`);
    if (fields) return;
    if (op.response) {
      const errors = schemas.validate(schemas.component(op.response), body);
      if (errors.length > 0)
        violations.push(`${op.id}: response ${JSON.stringify(errors.slice(0, 3))}`);
    } else if (body !== undefined) {
      violations.push(`${op.id}: documented an empty body`);
    }
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const text = await readBody(req);
      let body: unknown = undefined;
      let parseError: string | null = null;
      if (text !== "") {
        try {
          body = JSON.parse(text);
        } catch (error) {
          parseError = String(error);
        }
      }
      // Control endpoint for out-of-process suites: queue an injected response.
      if (req.method === "POST" && url.pathname === "/__contract/fail-next") {
        injected.push(body as InjectedResponse);
        res.writeHead(204);
        res.end();
        return;
      }
      // The API serves its own document (Section 10.1).
      if (req.method === "GET" && url.pathname === "/api/v1/openapi.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(document));
        return;
      }
      const path = url.pathname.replace(/^\/api\/v1/, "");
      let route: Route | undefined;
      let params: Record<string, string> = {};
      for (const r of routes) {
        if (r.op.method !== req.method) continue;
        const m = r.regex.exec(path);
        if (m) {
          route = r;
          params = Object.fromEntries(
            r.params.map((p, i) => [p, decodeURIComponent(m[i + 1] as string)]),
          );
          break;
        }
      }
      requests.push({
        method: req.method ?? "",
        path,
        query: url.searchParams,
        headers: req.headers,
        body,
        operationId: route?.op.id ?? null,
      });

      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        const isProblem = status >= 400;
        // An injected string body is sent verbatim, so tests can send malformed or non-JSON bodies.
        const json =
          payload === undefined
            ? ""
            : typeof payload === "string"
              ? payload
              : JSON.stringify(payload);
        res.writeHead(status, {
          ...(json
            ? { "Content-Type": isProblem ? "application/problem+json" : "application/json" }
            : {}),
          "RateLimit-Limit": "600",
          "RateLimit-Remaining": "599",
          "RateLimit-Reset": "60",
          ...headers,
        });
        res.end(json);
      };

      const next = injected.shift();
      if (next) {
        send(
          next.status,
          next.body ?? {
            type: "/problems/injected",
            title: "Injected",
            status: next.status,
            detail: "Injected by the test.",
          },
          next.headers,
        );
        return;
      }
      try {
        if (!url.pathname.startsWith("/api/v1/") || !route) {
          throw new HttpProblem(
            404,
            "not-found",
            "Not Found",
            `No operation answers ${req.method} ${url.pathname}.`,
          );
        }
        if (req.headers.authorization !== `Bearer ${apiKey}`) {
          throw new HttpProblem(
            401,
            "unauthorized",
            "Unauthorized",
            "Send a valid API key as a bearer token.",
          );
        }
        const op = route.op;
        validateQuery(op, url.searchParams);
        if (parseError) throw new HttpProblem(400, "malformed-json", "Bad Request", parseError);
        if (op.body) {
          if (body === undefined && op.bodyRequired) {
            throw new HttpProblem(
              400,
              "missing-body",
              "Bad Request",
              `${op.id} requires a ${op.body} body.`,
            );
          }
          if (body !== undefined) {
            const errors = schemas.validate(schemas.component(op.body), body);
            if (errors.length > 0) {
              throw new HttpProblem(
                422,
                "validation",
                "Unprocessable Content",
                `${errors.length} member(s) of the request are invalid.`,
                { errors },
              );
            }
          }
        } else if (body !== undefined) {
          throw new HttpProblem(400, "unexpected-body", "Bad Request", `${op.id} takes no body.`);
        }
        let replayKey: string | null = null;
        let hash = "";
        if (op.idempotent) {
          const key = req.headers["idempotency-key"];
          if (typeof key !== "string" || key.length < 8 || key.length > 255) {
            throw new HttpProblem(
              400,
              "idempotency-key-required",
              "Bad Request",
              "Send an Idempotency-Key of 8 to 255 characters.",
            );
          }
          replayKey = `${op.id}:${key}`;
          hash = createHash("sha256").update(`${path}:${text}`).digest("hex");
          const prior = idempotency.get(replayKey);
          if (prior) {
            if (prior.hash !== hash) {
              throw new HttpProblem(
                409,
                "idempotency-key-reused",
                "Conflict",
                "This Idempotency-Key was used with a different request.",
              );
            }
            send(prior.status, prior.body, { ...prior.headers, "Idempotent-Replayed": "true" });
            return;
          }
        }
        const result = handle(route, params, url.searchParams, body, req.headers);
        checkResponse(op, result.status, result.body, url.searchParams.get("fields"));
        if (replayKey) idempotency.set(replayKey, { hash, ...result });
        send(result.status, result.body, result.headers);
      } catch (error) {
        if (error instanceof HttpProblem) {
          const problem = { ...error.body, instance: url.pathname };
          checkResponse(route?.op ?? null, error.status, problem, null);
          send(error.status, problem);
        } else {
          violations.push(`Unhandled ${req.method} ${url.pathname}: ${String(error)}`);
          send(500, {
            type: "/problems/internal",
            title: "Internal Server Error",
            status: 500,
            detail: String(error),
          });
        }
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    apiKey,
    requests,
    violations,
    operations: ir.operations,
    failNext: (response) => injected.push(response),
    seed: (collection, row) => {
      // Members the caller leaves out are filled from the document's examples, so the row validates.
      const route = routes.find((r) => r.collection === collection && r.key !== null);
      const base = route ? synthesizeRow(route, null).value : {};
      const value = { ...base, ...row };
      const key = String(route ? value[keyField(route)] : (value["id"] ?? Object.values(row)[0]));
      collectionOf(collection).set(key, { value, version: 1 });
    },
    rows: (collection) => [...collectionOf(collection).values()].map((r) => r.value),
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
