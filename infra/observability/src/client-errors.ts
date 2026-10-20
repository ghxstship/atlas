/**
 * The server half of the browser error reporter (`browser.ts`): the handler behind each app's
 * same-origin `POST /api/client-errors` route.
 *
 * In order, it refuses a request from another origin (403), a body over 8 KB (413) and a caller
 * over its rate (429); parses the payload with the app's schema (400 when invalid); then runs the
 * message, stack and route through the redactor and reports the error through the server error
 * reporter, tagged `runtime:browser`, so it reaches Sentry with the server client's scrubbing and
 * the structured log. Without a Sentry DSN the reporter has no sink and only logs. Nothing in the
 * payload is echoed back.
 */

import type { ErrorReporter } from "./errors.ts";
import { redactString, redactUrl } from "./redact.ts";

/** What the app's schema returns for a valid payload (see `ClientErrorPayload` in `browser.ts`). */
export interface ClientErrorReport {
  readonly message: string;
  readonly stack?: string | undefined;
  readonly route: string;
  readonly source: "window" | "promise" | "boundary";
  readonly release?: string | undefined;
  readonly userId?: string | undefined;
}

export const MAX_CLIENT_ERROR_BYTES = 8 * 1024;

export interface RateLimiter {
  /** True when `key` may make one more request now; counts the request when it may. */
  take(key: string): boolean;
}

/**
 * A fixed-window limiter held in memory: `limit` requests per key per window, and `globalLimit`
 * across all keys, per server instance. Serverless instances do not share it, so it bounds the
 * load one instance takes, which is what protects the Sentry quota from a looping page.
 */
export function createRateLimiter(options: {
  readonly limit: number;
  readonly globalLimit: number;
  readonly windowMs: number;
  readonly now?: () => number;
}): RateLimiter {
  const now = options.now ?? (() => Date.now());
  let windowStart = now();
  let total = 0;
  const counts = new Map<string, number>();
  return {
    take(key) {
      const t = now();
      if (t - windowStart >= options.windowMs) {
        windowStart = t;
        total = 0;
        counts.clear();
      }
      const count = counts.get(key) ?? 0;
      if (count >= options.limit || total >= options.globalLimit) return false;
      counts.set(key, count + 1);
      total += 1;
      return true;
    },
  };
}

/**
 * The caller's address from the platform's forwarding headers, used only as a limiter key: the last
 * X-Forwarded-For entry, which the platform's proxy appended. The first entry is the client's own
 * text, so keying on it let one client take a fresh limit on every report (A69-003).
 */
export function clientKey(headers: Headers): string {
  const chain = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return chain.at(-1) || headers.get("x-real-ip")?.trim() || "unknown";
}

export interface ClientErrorHandlerOptions {
  readonly errors: ErrorReporter;
  /** The app's zod schema, as `(input) => schema.safeParse(input)`. */
  readonly parse: (
    input: unknown,
  ) => { success: true; data: ClientErrorReport } | { success: false };
  readonly limiter: RateLimiter;
  /** The site's public origin (`ATLAS_SITE_URL`); the request's own origin is accepted too. */
  readonly siteOrigin?: string | undefined;
  /** Sends queued events before the response, where the platform may freeze the instance after. */
  readonly flush?: (() => Promise<unknown>) | undefined;
}

function sameOrigin(request: Request, siteOrigin: string | undefined): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  if (origin === new URL(request.url).origin) return true;
  if (!siteOrigin) return false;
  try {
    return origin === new URL(siteOrigin).origin;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

function status(code: number): Response {
  return new Response(null, { status: code, headers: { "Cache-Control": "no-store" } });
}

/** Rebuilds the browser error as an Error whose message and stack are redacted. */
export function toBrowserError(report: ClientErrorReport): Error {
  const error = new Error(redactString(report.message, 1024));
  error.name = "BrowserError";
  const frames = report.stack ? redactString(report.stack, 8192) : "";
  error.stack = frames
    ? `${error.name}: ${error.message}\n${frames}`
    : `${error.name}: ${error.message}`;
  return error;
}

export function createClientErrorHandler(
  options: ClientErrorHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!sameOrigin(request, options.siteOrigin)) return status(403);
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_CLIENT_ERROR_BYTES) return status(413);
    if (!options.limiter.take(clientKey(request.headers))) return status(429);
    const body = await request.text();
    if (body.length > MAX_CLIENT_ERROR_BYTES) return status(413);
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch (error) {
      if (error instanceof SyntaxError) return status(400);
      throw error;
    }
    const parsed = options.parse(input);
    if (!parsed.success) return status(400);
    const report = parsed.data;
    options.errors.report(toBrowserError(report), {
      tags: {
        runtime: "browser",
        source: report.source,
        route: redactUrl(report.route),
        ...(report.release ? { browser_release: redactString(report.release, 64) } : {}),
      },
      ...(report.userId ? { user: { id: report.userId } } : {}),
    });
    await options.flush?.();
    return status(204);
  };
}
