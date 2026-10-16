/**
 * Request instrumentation for fetch-style handlers: Next.js route handlers in Atlas and Gateway
 * (including the Hono app at /api/v1) and Supabase Edge Functions (`Deno.serve`).
 *
 * For each request the wrapper continues or starts a W3C trace, opens a SERVER span, hands the
 * handler a logger bound to the request and trace ids, writes one completion record, reports a
 * thrown error once and rethrows it, and echoes `traceparent` and `x-request-id` on the response.
 * Paths are logged without their query string; headers are never logged.
 */

import type { ErrorReporter } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { redactUrl } from "./redact.ts";
import {
  continueTrace,
  formatTraceparent,
  requestIdFrom,
  type TraceContext,
} from "./trace-context.ts";
import { SpanKind, SpanStatus, setSpanAttributes, withSpan, type TracerLike } from "./tracing.ts";

export interface RequestScope {
  readonly logger: Logger;
  readonly trace: TraceContext;
  readonly requestId: string;
}

export interface ObserveOptions {
  readonly logger: Logger;
  readonly errors: ErrorReporter;
  readonly tracer?: TracerLike | undefined;
  /** The route template, for example `/api/v1/projects/{id}`; never the concrete path. */
  readonly route: string;
  readonly now?: () => number;
}

export type ObservedHandler<A extends unknown[]> = (
  request: Request,
  scope: RequestScope,
  ...rest: A
) => Promise<Response> | Response;

/** Requests slower than this are logged at warn level (Section 5.1 p99 target). */
export const SLOW_REQUEST_MS = 800;

export function observe<A extends unknown[]>(
  handler: ObservedHandler<A>,
  options: ObserveOptions,
): (request: Request, ...rest: A) => Promise<Response> {
  const now = options.now ?? (() => performance.now());
  return async (request, ...rest) => {
    const started = now();
    const trace = continueTrace(request.headers.get("traceparent"));
    const requestId = requestIdFrom(request.headers);
    const path = redactUrl(new URL(request.url).pathname);
    const method = request.method.toUpperCase();
    const logger = options.logger.child({
      request_id: requestId,
      trace_id: trace.traceId,
      span_id: trace.spanId,
      http_route: options.route,
    });
    const attributes = {
      "http.request.method": method,
      "http.route": options.route,
      "url.path": path,
      "xos.request_id": requestId,
    };
    return withSpan(
      `${method} ${options.route}`,
      { tracer: options.tracer, kind: SpanKind.SERVER, attributes, parent: trace },
      async (span) => {
        const active = span.spanContext();
        const scopeTrace: TraceContext = {
          traceId: active.traceId,
          spanId: active.spanId,
          sampled: trace.sampled,
        };
        const scopedLogger =
          active.traceId === trace.traceId && active.spanId === trace.spanId
            ? logger
            : logger.child({ trace_id: active.traceId, span_id: active.spanId });
        try {
          const response = await handler(
            request,
            { logger: scopedLogger, trace: scopeTrace, requestId },
            ...rest,
          );
          const status = response.status;
          setSpanAttributes(span, { "http.response.status_code": status });
          if (status >= 500) span.setStatus({ code: SpanStatus.ERROR });
          const durationMs = Math.round(now() - started);
          const fields = { method, path, status, duration_ms: durationMs };
          if (status >= 500) scopedLogger.error("request failed", fields);
          else if (durationMs > SLOW_REQUEST_MS) scopedLogger.warn("request slow", fields);
          else scopedLogger.info("request completed", fields);
          return withCorrelationHeaders(response, scopeTrace, requestId);
        } catch (error) {
          options.errors.report(error, {
            tags: { route: options.route, method },
            extra: { path, request_id: requestId, trace_id: scopeTrace.traceId },
          });
          scopedLogger.error("request threw", {
            method,
            path,
            duration_ms: Math.round(now() - started),
          });
          throw error;
        }
      },
    );
  };
}

/** Adds `traceparent` and `x-request-id`; copies the response when its headers are immutable. */
export function withCorrelationHeaders(
  response: Response,
  trace: TraceContext,
  requestId: string,
): Response {
  const traceparent = formatTraceparent(trace);
  try {
    response.headers.set("traceparent", traceparent);
    response.headers.set("x-request-id", requestId);
    return response;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const headers = new Headers(response.headers);
    headers.set("traceparent", traceparent);
    headers.set("x-request-id", requestId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/** The request argument Next.js passes to `onRequestError` in instrumentation.ts. */
export interface NextErrorRequest {
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** The context argument Next.js passes to `onRequestError`. */
export interface NextErrorContext {
  readonly routerKind: string;
  readonly routePath: string;
  readonly routeType: string;
  readonly renderSource?: string;
  readonly revalidateReason?: string;
}

function headerValue(headers: NextErrorRequest["headers"], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Builds the Next.js `onRequestError` export for instrumentation.ts. Errors already reported by
 * `observe` are skipped, so each error reaches the sink once.
 */
export function createOnRequestError(errors: ErrorReporter) {
  return async (
    error: unknown,
    request: NextErrorRequest,
    context: NextErrorContext,
  ): Promise<void> => {
    if (errors.wasReported(error)) return;
    const trace = continueTrace(headerValue(request.headers, "traceparent"));
    errors.report(error, {
      tags: {
        route: context.routePath,
        route_type: context.routeType,
        router: context.routerKind,
        ...(context.renderSource ? { render_source: context.renderSource } : {}),
      },
      extra: {
        method: request.method,
        path: redactUrl(request.path),
        trace_id: trace.traceId,
        request_id:
          headerValue(request.headers, "x-request-id") ??
          headerValue(request.headers, "x-vercel-id"),
      },
    });
  };
}
