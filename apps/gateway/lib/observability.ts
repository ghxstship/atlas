import { trace } from "@opentelemetry/api";
import * as Sentry from "@sentry/nextjs";
import { createObservability, sentryDsn } from "@xos/infra/observability";

/**
 * Gateway telemetry (ADR 0025, infra/observability/README.md): the redacting logger, the error
 * reporter and the tracer, for server code on the Node and Edge runtimes. Never import this from a
 * client component; the browser reports through `@xos/infra/observability/browser`.
 *
 * Without a Sentry DSN (local runs, tests, CI) there is no error sink and no tracer, so errors and
 * spans reach only the structured log and nothing leaves the process. Token flow pages never put a
 * token in a log field or span attribute; the redactor replaces `token` and `token_hash` anyway.
 */
export const sentryEnabled = sentryDsn(process.env) !== undefined;

export const observability = createObservability({
  service: "gateway",
  env: process.env,
  tracer: sentryEnabled ? trace.getTracer("gateway") : undefined,
  errorSink: sentryEnabled ? Sentry : undefined,
});

/** Sends queued Sentry events before a response, so a frozen serverless instance loses none. */
export async function flushErrors(): Promise<void> {
  if (sentryEnabled) await Sentry.flush(2000);
}
