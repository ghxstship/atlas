import * as Sentry from "@sentry/nextjs";
import { createOnRequestError, sentryInitOptions } from "@xos/infra/observability";

/**
 * Runs once when the Gateway server boots, on the Node and Edge runtimes.
 *   1. Validates the environment (lib/env.ts), so a missing variable fails fast with a clear
 *      message instead of on the first request.
 *   2. Starts the Sentry server client when a DSN is set (`SENTRY_DSN`, else
 *      `NEXT_PUBLIC_SENTRY_DSN`): every event and transaction passes `scrubEvent`, default PII is
 *      off and `XOS_TRACES_SAMPLE_RATE` (default 0.05) sets the trace sample. Without a DSN nothing
 *      starts and nothing leaves the process. There is no browser SDK and no Session Replay; the
 *      browser reports through /api/client-errors (ADR 0025).
 */
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] === "nodejs") {
    const { env } = await import("./lib/env");
    env();
  }
  const options = sentryInitOptions("gateway", process.env);
  if (options) Sentry.init(options);
}

/** Reports errors thrown while rendering or handling a request, once each (ADR 0025). */
export const onRequestError = async (
  ...args: Parameters<ReturnType<typeof createOnRequestError>>
): Promise<void> => {
  const { observability, flushErrors } = await import("./lib/observability");
  await createOnRequestError(observability.errors)(...args);
  await flushErrors();
};
