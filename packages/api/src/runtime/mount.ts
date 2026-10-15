/**
 * Mounts module handlers onto the registered routes. An operation without a handler is never
 * added to the router, so it answers 404 like any unknown path, never with a stub.
 *
 * For each mounted operation the runtime:
 * 1. resolves the caller (401 without a valid credential);
 * 2. validates path parameters, query (including `filter[field][op]`) and JSON body with the
 *    route's zod schemas (422 with one JSON Pointer per invalid member);
 * 3. checks `Idempotency-Key` on POST (400 when absent) and `If-Match` on PATCH (428 when absent);
 * 4. applies the caller's rate limit (429 with `Retry-After`; headers on every response);
 * 5. replays or claims the Idempotency-Key of a POST in the tenant's ledger;
 * 6. runs the handler and serializes its typed result, adding `ETag` where the contract declares
 *    it, and maps thrown problems and database errors to RFC 9457 responses.
 */
import { z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono, RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { z } from "zod";
import type { Module } from "../catalog/types.ts";
import {
  ApiProblem,
  badRequest,
  fromDatabaseError,
  internalError,
  isDatabaseError,
  preconditionRequired,
  problemResponse,
  toPointer,
  unauthorized,
  validationProblem,
} from "../problem.ts";
import type { ValidationIssue } from "../problem.ts";
import type { Authenticate, RequestContext } from "./context.ts";
import { etagOf } from "./etag.ts";
import { databaseIdempotencyStore, inProgress, keyReused, requestHash } from "./idempotency.ts";
import type { IdempotencyStore } from "./idempotency.ts";
import { createWindowRateLimiter, enforce, rateLimitHeaders } from "./rate-limit.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { AnyModuleHandlers, ErasedHandler, ErasedRequest, ErasedResult } from "./handler.ts";
import { parseQuery } from "./query.ts";

const JSON_MEDIA_TYPE = "application/json";

export interface MountOptions {
  readonly authenticate: Authenticate;
  /** Validate every success body against the route's response schema (contract tests turn it on). */
  readonly validateResponses?: boolean;
  /** Receives errors the contract does not name, before the runtime answers 500. */
  readonly onError?: (error: unknown, requestId: string) => void;
  /** Request id generator; defaults to `crypto.randomUUID`. */
  readonly requestId?: () => string;
  /** Idempotency-Key ledger; defaults to A18's `app.idempotency_keys`. `false` turns storage off. */
  readonly idempotency?: IdempotencyStore | false;
  /** Rate limiter; defaults to 600 requests a minute per caller in this process. */
  readonly rateLimiter?: RateLimiter | false;
}

/** What the runtime knows about one operation, taken from its route definition. */
export interface OperationRoute {
  readonly operationId: string;
  readonly module: Module;
  readonly method: string;
  readonly path: string;
  readonly params: z.ZodType | undefined;
  readonly query: z.ZodType | undefined;
  readonly body: z.ZodType | undefined;
  readonly responses: ReadonlyMap<number, z.ZodType | undefined>;
  /** Success statuses whose response declares an `ETag` header. */
  readonly etag: ReadonlySet<number>;
  /** `x-xos-capability`: the capability the operation requires. */
  readonly capability: string | undefined;
}

/**
 * The path parameter schema for request validation: path segments arrive as strings, so an
 * integer key (a canon rank or generation) is converted to a number before its own schema checks
 * it. Only validation changes; the documented parameter stays an integer.
 */
export function coercePathParams(schema: z.ZodType | undefined): z.ZodType | undefined {
  if (!(schema instanceof zod.ZodObject)) return schema;
  const shape = schema.shape as Record<string, z.ZodType>;
  if (!Object.values(shape).some((s) => s instanceof zod.ZodNumber)) return schema;
  return zod.object(
    Object.fromEntries(
      Object.entries(shape).map(([name, s]) => [
        name,
        s instanceof zod.ZodNumber
          ? zod.preprocess((v) => (typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : v), s)
          : s,
      ]),
    ),
  );
}

function asZod(value: unknown): z.ZodType | undefined {
  return typeof value === "object" && value !== null && "safeParse" in value
    ? (value as z.ZodType)
    : undefined;
}

export function operationRoute(route: RouteConfig): OperationRoute {
  const r = route as RouteConfig & { operationId: string; tags: Module[] };
  const content = (route.request?.body as { content?: Record<string, { schema?: unknown }> })
    ?.content;
  const responses = new Map<number, z.ZodType | undefined>();
  const etag = new Set<number>();
  for (const [status, response] of Object.entries(route.responses)) {
    if (!/^2\d\d$/.test(status)) continue;
    const r = response as {
      content?: Record<string, { schema?: unknown }>;
      headers?: Record<string, unknown>;
    };
    responses.set(Number(status), asZod(r.content?.[JSON_MEDIA_TYPE]?.schema));
    if (r.headers !== undefined && "ETag" in r.headers) etag.add(Number(status));
  }
  return {
    operationId: r.operationId,
    module: r.tags[0] as Module,
    method: route.method,
    path: route.path,
    params: coercePathParams(asZod(route.request?.params)),
    query: asZod(route.request?.query),
    body: asZod(content?.[JSON_MEDIA_TYPE]?.schema),
    responses,
    etag,
    capability: (route as { "x-xos-capability"?: string })["x-xos-capability"],
  };
}

/** Hono path syntax for an OpenAPI path. */
export function honoPath(path: string): string {
  return path.replaceAll(/\/{(.+?)}/g, "/:$1");
}

/**
 * Router order: at each segment a static segment sorts before a parameter, so
 * `/projects/summary` is matched before `/projects/{id}`. It is a total order (static segments
 * compare as strings, then the shorter path first, then the method), so the sort gives the same
 * order whatever order the routes arrive in.
 */
export function compareRoutes(a: OperationRoute, b: OperationRoute): number {
  const sa = a.path.split("/");
  const sb = b.path.split("/");
  for (let i = 0; i < Math.min(sa.length, sb.length); i += 1) {
    const x = sa[i] as string;
    const y = sb[i] as string;
    const pa = x.startsWith("{");
    const pb = y.startsWith("{");
    if (pa !== pb) return pa ? 1 : -1;
    if (!pa && x !== y) return x < y ? -1 : 1;
  }
  if (sa.length !== sb.length) return sa.length - sb.length;
  return a.method < b.method ? -1 : a.method > b.method ? 1 : 0;
}

function issues(error: z.ZodError, prefix: string): ValidationIssue[] {
  return error.issues.map((i) => ({ pointer: prefix + toPointer(i.path), detail: i.message }));
}

async function readBody(c: Context): Promise<unknown> {
  const type = c.req.header("content-type") ?? "";
  if (!type.toLowerCase().startsWith(JSON_MEDIA_TYPE)) {
    throw badRequest("Send the request body as application/json.");
  }
  const text = await c.req.text();
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw badRequest(`The request body is not valid JSON: ${(error as Error).message}`);
  }
}

/** Validates the request members and returns them, or throws a 422 problem. */
async function validateRequest(c: Context, op: OperationRoute): Promise<ErasedRequest> {
  const found: ValidationIssue[] = [];
  const check = (schema: z.ZodType | undefined, value: unknown, prefix: string): unknown => {
    if (schema === undefined) return {};
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    found.push(...issues(result.error, prefix));
    return undefined;
  };

  const params = check(op.params, c.req.param(), "/params");
  const query = check(op.query, parseQuery(new URL(c.req.url).searchParams), "/query");
  let body: unknown = undefined;
  if (op.body !== undefined) {
    const raw = await readBody(c);
    const result = op.body.safeParse(raw);
    if (result.success) body = result.data;
    else found.push(...issues(result.error, ""));
  }

  const idempotencyKey = c.req.header("idempotency-key");
  const ifMatch = c.req.header("if-match");
  if (op.method === "post") {
    if (idempotencyKey === undefined) {
      throw badRequest("Send an Idempotency-Key header with every POST.");
    }
    if (idempotencyKey.length < 8 || idempotencyKey.length > 255) {
      found.push({ pointer: "/headers/Idempotency-Key", detail: "Use 8 to 255 characters." });
    }
  }
  if (found.length > 0) {
    throw new ApiProblem(validationProblem(found, new URL(c.req.url).pathname));
  }
  return {
    operationId: op.operationId,
    params: params as Record<string, unknown>,
    query: query as Record<string, unknown>,
    body,
    idempotencyKey,
    ifMatch,
  };
}

function toProblem(error: unknown, requestId: string, options: MountOptions): ApiProblem {
  if (error instanceof ApiProblem) return error;
  if (isDatabaseError(error)) {
    const mapped = fromDatabaseError(error);
    if (mapped !== undefined) return mapped;
  }
  options.onError?.(error, requestId);
  return internalError(requestId);
}

function contractViolation(op: OperationRoute, detail: string): Error {
  return new Error(`${op.operationId} returned a response outside its contract: ${detail}`);
}

interface Shape {
  readonly shape?: Record<string, unknown>;
  partial?: () => z.ZodType;
}

/**
 * Validates a body against its response schema. With a sparse fieldset, fields may be absent,
 * so objects (and the items of a page) are checked as partial shapes.
 */
function checkBody(schema: z.ZodType, body: unknown, sparse: boolean): string[] {
  const issues = (result: { success: boolean; error?: z.ZodError }, prefix = "") =>
    result.success
      ? []
      : (result.error as z.ZodError).issues.map(
          (i) => `${prefix}${toPointer(i.path)} ${i.message}`,
        );
  const shaped = schema as unknown as Shape;
  if (!sparse || shaped.shape === undefined) return issues(schema.safeParse(body));
  const data = shaped.shape["data"] as { element?: Shape } | undefined;
  const element = data?.element;
  if (element?.partial !== undefined && Array.isArray((body as { data?: unknown }).data)) {
    const partial = element.partial();
    const page = body as { data: unknown[]; next_cursor?: unknown };
    return [
      ...page.data.flatMap((item, i) => issues(partial.safeParse(item), `/data/${i}`)),
      ...(typeof page.next_cursor === "string" || page.next_cursor === null
        ? []
        : ["/next_cursor must be a string or null"]),
    ];
  }
  return shaped.partial === undefined
    ? issues(schema.safeParse(body))
    : issues(shaped.partial().safeParse(body));
}

/** An API key reaches only the capability groups in its scopes (OAuth scopes map the same way). */
function assertScope(op: OperationRoute, context: RequestContext): void {
  if (context.scopes === undefined || op.capability === undefined) return;
  const group = op.capability.split(".")[0] as string;
  if (!context.scopes.includes(group)) {
    throw unauthorized(
      `This credential's scopes do not include ${group}, which ${op.operationId} needs.`,
    );
  }
}

async function runIdempotent(
  store: IdempotencyStore | undefined,
  context: RequestContext,
  op: OperationRoute,
  request: ErasedRequest,
  path: string,
  run: () => Promise<ErasedResult>,
): Promise<{ result: ErasedResult; replayed: boolean }> {
  const key = request.idempotencyKey;
  if (store === undefined || key === undefined || op.method !== "post") {
    return { result: await run(), replayed: false };
  }
  const hash = requestHash(context.user.id, op.method, path, request.body);
  const begun = await store.begin(context, key, hash);
  if (begun.outcome === "replay") {
    return { result: { status: begun.response.status, body: begun.response.body }, replayed: true };
  }
  if (begun.outcome === "in_progress") throw inProgress();
  if (begun.outcome === "mismatch") throw keyReused();
  let result: ErasedResult;
  try {
    result = await run();
  } catch (error) {
    await store.abandon(context, key);
    throw error;
  }
  await store.complete(context, key, { status: result.status, body: result.body });
  return { result, replayed: false };
}

function serve(
  op: OperationRoute,
  handler: ErasedHandler,
  options: MountOptions,
  limiter: RateLimiter | undefined,
) {
  const store =
    options.idempotency === false ? undefined : (options.idempotency ?? databaseIdempotencyStore);
  return async (c: Context): Promise<Response> => {
    const requestId = options.requestId?.() ?? crypto.randomUUID();
    const instance = new URL(c.req.url).pathname;
    let base: Record<string, string> = { "X-Request-Id": requestId };
    try {
      const context = await options.authenticate(c.req.raw, requestId);
      if (context === null) throw unauthorized("Send a valid bearer token or session cookie.");
      assertScope(op, context);
      if (limiter !== undefined) {
        const decision = await limiter.take(`${context.credential}:${context.user.id}`);
        base = { ...base, ...rateLimitHeaders(decision) };
        enforce(decision);
      }
      const request = await validateRequest(c, op);
      if (op.method === "patch" && request.ifMatch === undefined) throw preconditionRequired();
      const { result, replayed } = await runIdempotent(store, context, op, request, instance, () =>
        handler(request, context),
      );
      if (!op.responses.has(result.status)) {
        throw contractViolation(op, `status ${result.status} is not a documented success status`);
      }
      const schema = op.responses.get(result.status);
      if (options.validateResponses === true && schema !== undefined) {
        const sparse = typeof request.query["fields"] === "string";
        const found = checkBody(schema, result.body, sparse);
        if (found.length > 0) throw contractViolation(op, found.join("; "));
      }
      const headers: Record<string, string> = { ...base, ...result.headers };
      if (replayed) headers["Idempotent-Replayed"] = "true";
      if (result.status === 204 || schema === undefined) {
        return new Response(null, { status: result.status, headers });
      }
      if (op.etag.has(result.status) && headers["ETag"] === undefined) {
        headers["ETag"] = etagOf(result.body);
      }
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { ...headers, "Content-Type": JSON_MEDIA_TYPE },
      });
    } catch (error) {
      const problem = toProblem(error, requestId, options);
      return problemResponse(
        { ...problem.body, instance: problem.body.instance ?? instance },
        { ...base, ...problem.headers },
      );
    }
  };
}

/**
 * Mounts every handler found in `modules` onto `app`. Throws at startup when a handler names an
 * operation that does not exist or belongs to another module, so mistakes never reach a request.
 * Returns the operationIds that were mounted.
 */
export function mountHandlers(
  app: OpenAPIHono,
  routes: readonly RouteConfig[],
  modules: readonly AnyModuleHandlers[],
  options: MountOptions,
): string[] {
  const byId = new Map(routes.map((r) => [(r as { operationId: string }).operationId, r]));
  const selected: [OperationRoute, ErasedHandler][] = [];
  for (const { module, handlers } of modules) {
    for (const [operationId, handler] of Object.entries(handlers)) {
      if (handler === undefined) continue;
      const route = byId.get(operationId);
      if (route === undefined)
        throw new Error(`${module} handler ${operationId} names no operation.`);
      const op = operationRoute(route);
      if (op.module !== module) {
        throw new Error(
          `${operationId} belongs to ${op.module}; move its handler out of ${module}.`,
        );
      }
      selected.push([op, handler]);
    }
  }
  selected.sort(([a], [b]) => compareRoutes(a, b));
  const limiter =
    options.rateLimiter === false ? undefined : (options.rateLimiter ?? createWindowRateLimiter());
  for (const [op, handler] of selected) {
    app.on(op.method.toUpperCase(), honoPath(op.path), serve(op, handler, options, limiter));
  }
  return selected.map(([op]) => op.operationId);
}
