/**
 * POST /api/client-errors: browser errors from instrumentation-client.ts and the error boundaries
 * (ADR 0025). Same-origin only, 8 KB at most, 10 reports a minute per caller and 300 per server
 * instance. The payload is validated, redacted and reported through the server Sentry client,
 * tagged `runtime:browser`; without a DSN it reaches only the structured log. Answers 204.
 */
import { createClientErrorHandler, createRateLimiter } from "@xos/infra/observability";
import { ClientErrorSchema } from "@/lib/client-errors";
import { env } from "@/lib/env";
import { flushErrors, observability } from "@/lib/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const limiter = createRateLimiter({ limit: 10, globalLimit: 300, windowMs: 60_000 });

let handler: ((request: Request) => Promise<Response>) | undefined;

export function POST(request: Request): Promise<Response> {
  handler ??= createClientErrorHandler({
    errors: observability.errors,
    parse: (input) => ClientErrorSchema.safeParse(input),
    limiter,
    siteOrigin: env().ATLAS_SITE_URL,
    flush: flushErrors,
  });
  return handler(request);
}
