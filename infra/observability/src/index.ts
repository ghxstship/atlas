/**
 * @xos/infra/observability: structured logs, traces and error reports with personal data redaction
 * for Atlas, Gateway, the public API and the Supabase Edge Functions.
 */

import { createErrorReporter, type ErrorReporter, type ErrorSink } from "./errors.ts";
import { createLogger, identityFromEnv, isLogLevel, type Logger } from "./logger.ts";
import type { TracerLike } from "./tracing.ts";

export * from "./errors.ts";
export * from "./http.ts";
export * from "./logger.ts";
export * from "./redact.ts";
export * from "./trace-context.ts";
export * from "./tracing.ts";

export interface Observability {
  readonly logger: Logger;
  readonly errors: ErrorReporter;
  readonly tracer: TracerLike | undefined;
}

export interface ObservabilityOptions {
  readonly service: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `trace.getTracer(service)` from `@opentelemetry/api`, once installed. */
  readonly tracer?: TracerLike | undefined;
  /** The Sentry namespace (`import * as Sentry from "@sentry/nextjs"`), once installed. */
  readonly errorSink?: ErrorSink | undefined;
  readonly sink?: (line: string) => void;
}

/**
 * One call per process: a logger tagged with the service identity, an error reporter that writes
 * to it and to the error sink, and the tracer. `XOS_LOG_LEVEL` sets the threshold (default info).
 */
export function createObservability(options: ObservabilityOptions): Observability {
  const level = options.env["XOS_LOG_LEVEL"];
  const logger = createLogger({
    ...identityFromEnv(options.service, options.env),
    ...(isLogLevel(level) ? { level } : {}),
    ...(options.sink ? { sink: options.sink } : {}),
  });
  return {
    logger,
    errors: createErrorReporter({ logger, sink: options.errorSink }),
    tracer: options.tracer,
  };
}
