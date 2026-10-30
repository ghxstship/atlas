/**
 * Typed errors. Every non-2xx response becomes an `XosApiError` subclass carrying the
 * RFC 9457 problem details; transport failures become `XosNetworkError`.
 */

/** The refusal outcomes of Section 3.7, the database enum `xpms.refusal`. */
// eslint-disable-next-line xos/no-restated-enums -- below @xos/data; test/database-enums.test.ts holds it equal
export const REFUSAL_KINDS = ["NO_ANSWER", "UNRATIFIED", "REFUSE"] as const;
export type RefusalKind = (typeof REFUSAL_KINDS)[number];

export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly refusal?: RefusalKind;
  readonly reason?: string;
  readonly rule?: string;
  readonly errors?: readonly { readonly pointer: string; readonly detail: string }[];
  readonly [extension: string]: unknown;
}

export class XosError extends Error {
  override name = "XosError";
}

/** The request never produced an HTTP response: DNS, connection, TLS or timeout. */
export class XosNetworkError extends XosError {
  override name = "XosNetworkError";
  readonly operationId: string;
  readonly timedOut: boolean;

  constructor(operationId: string, cause: unknown, timedOut: boolean) {
    super(
      timedOut
        ? `${operationId} timed out before the API answered.`
        : `${operationId} could not reach the API: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.operationId = operationId;
    this.timedOut = timedOut;
  }
}

/** The API answered with an error status. */
export class XosApiError extends XosError {
  override name = "XosApiError";
  readonly status: number;
  readonly problem: Problem;
  readonly operationId: string;
  readonly headers: Headers;

  constructor(operationId: string, problem: Problem, headers: Headers) {
    super(
      `${operationId} failed with ${problem.status} ${problem.title}${problem.detail ? `: ${problem.detail}` : ""}`,
    );
    this.status = problem.status;
    this.problem = problem;
    this.operationId = operationId;
    this.headers = headers;
  }
}

/** 400: the request is malformed. */
export class XosBadRequestError extends XosApiError {
  override name = "XosBadRequestError";
}

/** 401: the credential is missing, expired or revoked. */
export class XosAuthenticationError extends XosApiError {
  override name = "XosAuthenticationError";
}

/** 404: the resource does not exist or the caller may not see it (ADR 0003 never answers 403). */
export class XosNotFoundError extends XosApiError {
  override name = "XosNotFoundError";
}

/** 409: the request conflicts with the current state, for example an idempotency key reused with a different body. */
export class XosConflictError extends XosApiError {
  override name = "XosConflictError";
}

/** 412: `If-Match` named a stale version. Read the row again and retry with the new `ETag`. */
export class XosPreconditionFailedError extends XosApiError {
  override name = "XosPreconditionFailedError";
}

/** 428: the update was sent without `If-Match`. */
export class XosPreconditionRequiredError extends XosApiError {
  override name = "XosPreconditionRequiredError";
}

/** 422 with field errors: one JSON Pointer per invalid member. */
export class XosValidationError extends XosApiError {
  override name = "XosValidationError";
  get errors(): readonly { readonly pointer: string; readonly detail: string }[] {
    return this.problem.errors ?? [];
  }
}

/** 422 refusal (Section 3.7): the system declines to answer or act, and says why. */
export class XosRefusalError extends XosApiError {
  override name = "XosRefusalError";
  get refusal(): RefusalKind {
    return this.problem.refusal as RefusalKind;
  }
  get reason(): string {
    return this.problem.reason ?? "";
  }
  /** The separation of duties or policy rule that refused the request, when one did. */
  get rule(): string | null {
    return this.problem.rule ?? null;
  }
}

/** 429: rate limited after the client exhausted its retries. */
export class XosRateLimitError extends XosApiError {
  override name = "XosRateLimitError";
  /** Seconds the API asked the caller to wait, or null when it did not say. */
  get retryAfterSeconds(): number | null {
    return parseRetryAfter(this.headers.get("Retry-After"), Date.now());
  }
}

/** 5xx: the API failed. */
export class XosServerError extends XosApiError {
  override name = "XosServerError";
}

const REFUSALS = new Set<string>(REFUSAL_KINDS);

export function errorForProblem(
  operationId: string,
  problem: Problem,
  headers: Headers,
): XosApiError {
  switch (problem.status) {
    case 400:
      return new XosBadRequestError(operationId, problem, headers);
    case 401:
      return new XosAuthenticationError(operationId, problem, headers);
    case 404:
      return new XosNotFoundError(operationId, problem, headers);
    case 409:
      return new XosConflictError(operationId, problem, headers);
    case 412:
      return new XosPreconditionFailedError(operationId, problem, headers);
    case 428:
      return new XosPreconditionRequiredError(operationId, problem, headers);
    case 422:
      if (typeof problem.refusal === "string" && REFUSALS.has(problem.refusal)) {
        return new XosRefusalError(operationId, problem, headers);
      }
      return new XosValidationError(operationId, problem, headers);
    case 429:
      return new XosRateLimitError(operationId, problem, headers);
    default:
      return problem.status >= 500
        ? new XosServerError(operationId, problem, headers)
        : new XosApiError(operationId, problem, headers);
  }
}

/** Seconds from a `Retry-After` header, which is either delta seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null || value.trim() === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}
