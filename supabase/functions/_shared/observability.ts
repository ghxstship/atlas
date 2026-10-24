// Observability for the XOS Edge Functions (ADR 0025, infra/observability/README.md). The modules
// come from infra/observability through the vendored core (_vendor/core.js), because the Edge runtime
// only loads files inside supabase/functions.
//
// `observeFunction` wraps a handler with `observe`: it continues the caller's W3C trace, binds the
// request and trace ids to the structured logger, writes one redacted completion record, and echoes
// `traceparent` and `x-request-id`. An unexpected error becomes the generic 500 problem (A22-013)
// and, when the function has a `SENTRY_DSN` secret, one scrubbed Sentry event. Without the secret
// nothing leaves the function but the log.
import { internalErrorResponse, observeEdgeFunction } from "../_vendor/core.js";

export { createObservability, observe } from "../_vendor/core.js";

export function observeFunction(
  fn: string,
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return observeEdgeFunction(handler, {
    fn,
    env: Deno.env.toObject(),
    failure: (error, { requestId, logger }) =>
      internalErrorResponse(error, { requestId, logger, fn }),
  });
}
