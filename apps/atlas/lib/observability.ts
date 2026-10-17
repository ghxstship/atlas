import { trace } from "@opentelemetry/api";
import * as Sentry from "@sentry/nextjs";
import { createObservability, sentryDsn } from "@xos/infra/observability";

/**
 * Atlas telemetry (ADR 0025, infra/observability/README.md): the redacting logger, the error
 * reporter and the tracer, for server code on the Node and Edge runtimes. Never import this from a
 * client component; the browser reports through `@xos/infra/observability/browser`.
 *
 * Without a Sentry DSN (local runs, tests, CI) there is no error sink and no tracer, so errors and
 * spans reach only the structured log and nothing leaves the process.
 */
export const sentryEnabled = sentryDsn(process.env) !== undefined;

export const observability = createObservability({
  service: "atlas",
  env: process.env,
  tracer: sentryEnabled ? trace.getTracer("atlas") : undefined,
  errorSink: sentryEnabled ? Sentry : undefined,
});

/** Sends queued Sentry events before a response, so a frozen serverless instance loses none. */
export async function flushErrors(): Promise<void> {
  if (sentryEnabled) await Sentry.flush(2000);
}
