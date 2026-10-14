/**
 * Mounts module handlers onto the registered routes. An operation without a handler is never
 * added to the router, so it answers 404 like any unknown path, never with a stub.
 *
 * For each mounted operation the runtime:
 * 1. resolves the caller (401 without a valid credential);
 * 2. validates path parameters, query (including `filter[field][op]`) and JSON body with the
 *    route's zod schemas (422 with one JSON Pointer per invalid member);
 * 3. checks `Idempotency-Key` on POST (400 when absent) and `If-Match` on PATCH (428 when absent);
 * 4. runs the handler and serializes its typed result, mapping thrown problems and database
 *    errors to RFC 9457 responses.
 */
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
import type { Authenticate } from "./context.ts";
import type { AnyModuleHandlers, ErasedHandler, ErasedRequest } from "./handler.ts";
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
  for (const [status, response] of Object.entries(route.responses)) {
    if (!/^2\d\d$/.test(status)) continue;
    const media = (response as { content?: Record<string, { schema?: unknown }> }).content;
    responses.set(Number(status), asZod(media?.[JSON_MEDIA_TYPE]?.schema));
  }
  return {
    operationId: r.operationId,
    module: r.tags[0] as Module,
    method: route.method,
    path: route.path,
    params: asZod(route.request?.params),
    query: asZod(route.request?.query),
    body: asZod(content?.[JSON_MEDIA_TYPE]?.schema),
    responses,
  };
}

/** Hono path syntax for an OpenAPI path. */
export function honoPath(path: string): string {
  return path.replaceAll(/\/{(.+?)}/g, "/:$1");
}

/**
 * Router order: at each segment a static segment sorts before a parameter, so
 * `/projects/summary` is matched before `/projects/{id}`.
 */
export function compareRoutes(a: OperationRoute, b: OperationRoute): number {
  const sa = a.path.split("/");
  const sb = b.path.split("/");
  for (let i = 0; i < Math.min(sa.length, sb.length); i += 1) {
    const pa = (sa[i] as string).startsWith("{");
    const pb = (sb[i] as string).startsWith("{");
    if (pa !== pb) return pa ? 1 : -1;
  }
  return 0;
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

function serve(op: OperationRoute, handler: ErasedHandler, options: MountOptions) {
  return async (c: Context): Promise<Response> => {
    const requestId = options.requestId?.() ?? crypto.randomUUID();
    const instance = new URL(c.req.url).pathname;
    const base = { "X-Request-Id": requestId };
    try {
      const context = await options.authenticate(c.req.raw, requestId);
      if (context === null) throw unauthorized("Send a valid bearer token or session cookie.");
      const request = await validateRequest(c, op);
      if (op.method === "patch" && request.ifMatch === undefined) throw preconditionRequired();
      const result = await handler(request, context);
      if (!op.responses.has(result.status)) {
        throw contractViolation(op, `status ${result.status} is not a documented success status`);
      }
      if (options.validateResponses === true) {
        const schema = op.responses.get(result.status);
        if (schema !== undefined) {
          const parsed = schema.safeParse(result.body);
          if (!parsed.success) {
            throw contractViolation(
              op,
              parsed.error.issues.map((i) => `${toPointer(i.path)} ${i.message}`).join("; "),
            );
          }
        }
      }
      const headers = { ...base, ...result.headers };
      if (result.status === 204 || op.responses.get(result.status) === undefined) {
        return new Response(null, { status: result.status, headers });
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
  for (const [op, handler] of selected) {
    app.on(op.method.toUpperCase(), honoPath(op.path), serve(op, handler, options));
  }
  return selected.map(([op]) => op.operationId);
}
