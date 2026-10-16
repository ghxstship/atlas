/**
 * Error reporting (Section 5: Sentry for errors on web and mobile).
 *
 * `createErrorReporter` writes every error to the structured log and forwards it to an error sink.
 * The sink type is the structural subset of `@sentry/nextjs` (11.5.0, ADR 0001) that is called, so
 * `Sentry` itself is passed in once the apps install it. `scrubEvent` is the `beforeSend` and
 * `beforeSendTransaction` hook for every Sentry client: it strips cookies, credentials, personal
 * fields and query strings that the SDK collects on its own.
 */

import type { Logger } from "./logger.ts";
import { REDACTED, redact, redactString, redactUrl } from "./redact.ts";

export interface ErrorSink {
  captureException(
    exception: unknown,
    hint?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
  ): unknown;
}

export interface ErrorContext {
  /** Low-cardinality labels for grouping: route, operation id, function name. */
  readonly tags?: Readonly<Record<string, string>>;
  /** Anything else useful for diagnosis. Redacted before it leaves the process. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface ErrorReporter {
  report(error: unknown, context?: ErrorContext): void;
  /** True when this error object has already been reported (so a framework hook skips it). */
  wasReported(error: unknown): boolean;
}

export function createErrorReporter(options: {
  logger: Logger;
  sink?: ErrorSink | undefined;
}): ErrorReporter {
  const reported = new WeakSet<object>();
  return {
    report(error, context = {}) {
      if (typeof error === "object" && error !== null) {
        if (reported.has(error)) return;
        reported.add(error);
      }
      const tags = { ...context.tags };
      const extra = redact(context.extra ?? {}) as Record<string, unknown>;
      options.logger.error("unhandled error", { error, tags, ...extra });
      if (!options.sink) return;
      try {
        options.sink.captureException(error, { tags, extra });
      } catch (sinkError) {
        options.logger.warn("error sink rejected an event", { error: sinkError });
      }
    },
    wasReported(error) {
      return typeof error === "object" && error !== null && reported.has(error);
    },
  };
}

/** The parts of a Sentry event that can carry personal data. */
export interface SentryEventLike {
  message?: string;
  exception?: { values?: Array<{ type?: string; value?: string }> };
  request?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    cookies?: unknown;
    data?: unknown;
    query_string?: unknown;
    env?: unknown;
  };
  user?: {
    id?: string | number;
    email?: string;
    ip_address?: string | null;
    username?: string;
    [key: string]: unknown;
  };
  breadcrumbs?: Array<{ message?: string; data?: Record<string, unknown>; [key: string]: unknown }>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  server_name?: string;
  transaction?: string;
}

/** Request headers kept on error events; every other header is dropped. */
const KEPT_HEADERS = new Set([
  "accept",
  "content-type",
  "content-length",
  "traceparent",
  "x-request-id",
  "x-vercel-id",
  "sb-request-id",
]);

/**
 * Sentry `beforeSend` hook. Returns the same event object with personal data removed, so it can
 * be passed to `Sentry.init({ beforeSend: scrubEvent, beforeSendTransaction: scrubEvent })`.
 */
export function scrubEvent<E extends SentryEventLike>(event: E): E {
  if (event.message) event.message = redactString(event.message);
  for (const value of event.exception?.values ?? []) {
    if (value.value) value.value = redactString(value.value);
  }
  if (event.request) {
    const req = event.request;
    if (req.url) req.url = redactUrl(req.url);
    delete req.cookies;
    delete req.query_string;
    delete req.env;
    if (req.data !== undefined) req.data = REDACTED;
    if (req.headers) {
      const kept: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (KEPT_HEADERS.has(name.toLowerCase())) kept[name] = redactString(value);
      }
      req.headers = kept;
    }
  }
  if (event.user) {
    const id = event.user.id;
    event.user = id === undefined ? {} : { id };
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => {
      const next = { ...crumb };
      if (next.message) next.message = redactString(next.message);
      if (next.data) next.data = redact(next.data) as Record<string, unknown>;
      return next;
    });
  }
  if (event.extra) event.extra = redact(event.extra) as Record<string, unknown>;
  if (event.contexts) event.contexts = redact(event.contexts) as Record<string, unknown>;
  if (event.tags) event.tags = redact(event.tags) as Record<string, unknown>;
  if (event.transaction) event.transaction = redactUrl(event.transaction);
  delete event.server_name;
  return event;
}
