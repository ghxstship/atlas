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
    hint?: {
      tags?: Record<string, string>;
      extra?: Record<string, unknown>;
      user?: { id: string };
    },
  ): unknown;
}

export interface ErrorContext {
  /** Low-cardinality labels for grouping: route, operation id, function name. */
  readonly tags?: Readonly<Record<string, string>>;
  /** Anything else useful for diagnosis. Redacted before it leaves the process. */
  readonly extra?: Readonly<Record<string, unknown>>;
  /** The signed-in person's id (a UUID), the only user field an error report carries. */
  readonly user?: { readonly id: string };
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
        options.sink.captureException(error, {
          tags,
          extra,
          ...(context.user ? { user: { id: context.user.id } } : {}),
        });
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
  message?: string | undefined;
  exception?:
    | { values?: Array<{ type?: string | undefined; value?: string | undefined }> | undefined }
    | undefined;
  request?:
    | {
        url?: string | undefined;
        method?: string | undefined;
        headers?: Record<string, string> | undefined;
        cookies?: unknown;
        data?: unknown;
        query_string?: unknown;
        env?: unknown;
      }
    | undefined;
  user?:
    | {
        id?: string | number | undefined;
        email?: string | undefined;
        ip_address?: string | null | undefined;
        username?: string | undefined;
      }
    | undefined;
  breadcrumbs?:
    | Array<{
        message?: string | undefined;
        category?: string | undefined;
        data?: Record<string, unknown> | undefined;
      }>
    | undefined;
  extra?: Record<string, unknown> | undefined;
  contexts?: Record<string, unknown> | undefined;
  tags?: Record<string, unknown> | undefined;
  server_name?: string | undefined;
  transaction?: string | undefined;
  spans?:
    | Array<{
        description?: string | undefined;
        data?: Record<string, unknown> | undefined;
      }>
    | undefined;
}

/** Request headers kept on error events and spans; every other header is dropped. */
export const KEPT_REQUEST_HEADERS: readonly string[] = [
  "accept",
  "content-type",
  "content-length",
  "traceparent",
  "x-request-id",
  "x-vercel-id",
  "sb-request-id",
];
const KEPT_HEADERS = new Set(KEPT_REQUEST_HEADERS);

/** Span attributes that copy one HTTP header each (`http.request.header.accept`). */
const HEADER_ATTRIBUTE = /^http\.(request|response)\.header\.(.+)$/i;

/**
 * A span's attributes with every header outside the kept request headers removed, then redacted.
 * Next's router state header, for one, carries the page's route parameters, and a bearer link
 * carries its token there (A69-012).
 */
function scrubSpanData(data: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const [, direction = "", name = ""] = HEADER_ATTRIBUTE.exec(key) ?? [];
    const dropped =
      direction !== "" &&
      !(direction.toLowerCase() === "request" && KEPT_HEADERS.has(name.toLowerCase()));
    if (!dropped) kept[key] = value;
  }
  return redact(kept) as Record<string, unknown>;
}

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
  if (event.contexts) {
    const trace = event.contexts["trace"] as { data?: unknown } | undefined;
    const contexts = redact(event.contexts) as Record<string, unknown>;
    if (trace && typeof trace.data === "object" && trace.data !== null) {
      contexts["trace"] = {
        ...(contexts["trace"] as Record<string, unknown>),
        data: scrubSpanData(trace.data as Record<string, unknown>),
      };
    }
    event.contexts = contexts;
  }
  if (event.spans) {
    event.spans = event.spans.map((span) => {
      const next = { ...span };
      if (next.description) next.description = redactString(next.description);
      if (next.data) next.data = scrubSpanData(next.data);
      return next;
    });
  }
  if (event.tags) event.tags = redact(event.tags) as Record<string, unknown>;
  if (event.transaction) event.transaction = redactUrl(event.transaction);
  delete event.server_name;
  return event;
}
