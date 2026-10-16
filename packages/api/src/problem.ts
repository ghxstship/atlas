/**
 * RFC 9457 problem responses (ADR 0003, ADR 0007 item 3). Validation failures become 422
 * problem details with one JSON Pointer per invalid member; refusals become 422 with `refusal`
 * set; database errors map through `fromDatabaseError` (ADR 0008 item 3).
 */
import type { Context } from "hono";
import type { z } from "@hono/zod-openapi";
import { PROBLEM_MEDIA_TYPE } from "./conventions/components.ts";

export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly [extension: string]: unknown;
}

export function problemResponse(
  body: ProblemBody,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: { ...headers, "Content-Type": PROBLEM_MEDIA_TYPE },
  });
}

/** JSON Pointer (RFC 6901) for a Zod issue path. */
export function toPointer(path: readonly PropertyKey[]): string {
  return path.map((p) => `/${String(p).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

export type ValidationIssue = { readonly pointer: string; readonly detail: string };

export function validationProblem(
  issues: readonly ValidationIssue[],
  instance?: string,
): ProblemBody {
  return {
    type: "/problems/validation",
    title: "Unprocessable Content",
    status: 422,
    detail: `${issues.length} member(s) of the request are invalid.`,
    ...(instance === undefined ? {} : { instance }),
    errors: issues,
  };
}

type HookResult = { success: true } | { success: false; error: z.ZodError };

/** `defaultHook` for OpenAPIHono: turns a validation failure into a 422 problem. */
export function validationHook(result: HookResult, c: Context): Response | undefined {
  if (result.success) return undefined;
  return problemResponse(
    validationProblem(
      result.error.issues.map((i) => ({ pointer: toPointer(i.path), detail: i.message })),
      new URL(c.req.url).pathname,
    ),
  );
}

/** Refusal codes of Section 3.7. */
export type RefusalCode = "NO_ANSWER" | "UNRATIFIED" | "REFUSE";

/**
 * A problem a handler raises. The runtime serializes it as `application/problem+json`, adds
 * `instance`, and never leaks a stack trace.
 */
export class ApiProblem extends Error {
  readonly body: ProblemBody;
  readonly headers: Readonly<Record<string, string>>;

  constructor(body: ProblemBody, headers: Readonly<Record<string, string>> = {}) {
    super(body.detail ?? body.title);
    this.name = "ApiProblem";
    this.body = body;
    this.headers = headers;
  }
}

export function badRequest(detail: string): ApiProblem {
  return new ApiProblem({
    type: "/problems/bad-request",
    title: "Bad Request",
    status: 400,
    detail,
  });
}

export function unauthorized(detail: string): ApiProblem {
  return new ApiProblem(
    { type: "/problems/unauthorized", title: "Unauthorized", status: 401, detail },
    { "WWW-Authenticate": 'Bearer realm="xos"' },
  );
}

/** A missing resource, and a resource the caller may not see: always 404, never 403. */
export function notFound(
  detail = "No resource with this identifier is visible to you.",
): ApiProblem {
  return new ApiProblem({ type: "/problems/not-found", title: "Not Found", status: 404, detail });
}

export function conflict(detail: string): ApiProblem {
  return new ApiProblem({ type: "/problems/conflict", title: "Conflict", status: 409, detail });
}

export function preconditionFailed(
  detail = "The resource changed since you read it. Fetch it again and retry.",
): ApiProblem {
  return new ApiProblem({
    type: "/problems/precondition-failed",
    title: "Precondition Failed",
    status: 412,
    detail,
  });
}

export function preconditionRequired(detail = "Send the ETag you read as If-Match."): ApiProblem {
  return new ApiProblem({
    type: "/problems/precondition-required",
    title: "Precondition Required",
    status: 428,
    detail,
  });
}

/** A rule refused the request (Section 3.7): 422 with `refusal`, `reason` and the rule code. */
export function refused(refusal: RefusalCode, reason: string, rule?: string): ApiProblem {
  return new ApiProblem({
    type: "/problems/refused",
    title: "Refused",
    status: 422,
    detail: reason,
    refusal,
    reason,
    ...(rule === undefined ? {} : { rule }),
  });
}

export function rateLimited(retryAfterSeconds: number): ApiProblem {
  return new ApiProblem(
    {
      type: "/problems/rate-limited",
      title: "Too Many Requests",
      status: 429,
      detail: `Retry in ${retryAfterSeconds} seconds.`,
    },
    { "Retry-After": String(retryAfterSeconds) },
  );
}

export function internalError(requestId: string): ApiProblem {
  return new ApiProblem({
    type: "/problems/internal",
    title: "Internal Server Error",
    status: 500,
    detail: `The server could not complete the request. Quote request ${requestId} when reporting it.`,
  });
}

/** The shape of a PostgREST or Postgres error as supabase-js returns it. */
export interface DatabaseError {
  readonly code?: string;
  readonly message?: string;
  readonly details?: string | null;
  readonly hint?: string | null;
}

export function isDatabaseError(value: unknown): value is DatabaseError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DatabaseError).code === "string" &&
    typeof (value as DatabaseError).message === "string"
  );
}

/**
 * Maps a database error to a problem (ADR 0008 item 3), or returns undefined when the error is
 * not one the contract names, so the caller reports it as a server error.
 * - `XR001`: a refusal. The message is `<rule>: <sentence>` and the hint is the rule code.
 * - `42501` (insufficient privilege, including RLS) and PostgREST `PGRST116` (no row): 404.
 * - `23505` (unique violation): 409.
 * - `23514`, `23502`, `22P02`, `23503`: the request breaks a constraint: 422 validation.
 */
export function fromDatabaseError(error: DatabaseError): ApiProblem | undefined {
  const message = error.message ?? "";
  switch (error.code) {
    case "XR001": {
      const rule = error.hint ?? message.split(":")[0]?.trim() ?? undefined;
      const prefix = rule === undefined ? "" : `${rule}: `;
      const reason = message.startsWith(prefix) ? message.slice(prefix.length) : message;
      return refused("REFUSE", reason, rule);
    }
    case "42501":
    case "PGRST116":
      return notFound();
    case "23505":
      return conflict("A row with the same unique values already exists.");
    case "23514":
    case "23502":
    case "22P02":
    case "23503":
      return new ApiProblem(
        validationProblem([
          { pointer: "", detail: message === "" ? "A constraint refused the value." : message },
        ]),
      );
    default:
      return undefined;
  }
}
