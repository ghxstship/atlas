/**
 * Supabase Edge Function instrumentation (Deno). `observeEdgeFunction` wraps a handler with
 * `observe` under the service `edge.<fn>` and the route `/<fn>`, and turns an unexpected error into
 * the caller's failure response (the generic 500 problem of A22-013) after reporting it once: to
 * the structured log through `failure`, and to Sentry through the envelope sink when `SENTRY_DSN`
 * is set. Without the secret nothing leaves the function but the log.
 */

import { observe, type RequestScope } from "./http.ts";
import { createObservability } from "./index.ts";
import { createSentryEnvelopeSink } from "./sentry.ts";

export interface EdgeFunctionOptions {
  /** The function name, for example `kiosk-punch`. */
  readonly fn: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Logs the error with the scope's logger and builds the response the caller sees. */
  readonly failure: (error: unknown, scope: RequestScope) => Response;
  readonly fetch?: typeof fetch;
  /** Receives each serialized log line; defaults to stdout and stderr. */
  readonly logSink?: (line: string) => void;
  /** How long a failing request waits for its Sentry event to send. Default 2000 ms. */
  readonly flushMs?: number;
}

export function observeEdgeFunction(
  handler: (request: Request) => Promise<Response>,
  options: EdgeFunctionOptions,
): (request: Request) => Promise<Response> {
  const service = `edge.${options.fn}`;
  const observability = createObservability({
    service,
    env: options.env,
    ...(options.logSink ? { sink: options.logSink } : {}),
  });
  const sink = createSentryEnvelopeSink({
    service,
    env: options.env,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    onSendError: (error) => observability.logger.warn("sentry event not sent", { error }),
  });
  return observe(
    async (request, scope) => {
      try {
        return await handler(request);
      } catch (error) {
        if (sink) {
          sink.captureException(error, {
            tags: { function: options.fn, runtime: "edge-function" },
            extra: { request_id: scope.requestId, trace_id: scope.trace.traceId },
          });
          await sink.flush(options.flushMs ?? 2000);
        }
        return options.failure(error, scope);
      }
    },
    { ...observability, route: `/${options.fn}` },
  );
}
