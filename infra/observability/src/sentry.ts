/**
 * Sentry configuration shared by every runtime.
 *
 * `sentryInitOptions` is what Atlas and Gateway pass to `Sentry.init` from `@sentry/nextjs` on the
 * Node and Edge runtimes. Without a DSN it returns `undefined`, and the apps skip `Sentry.init`, so
 * local runs, tests and CI make no network calls.
 *
 * `createSentryEnvelopeSink` is the error sink for Supabase Edge Functions. No Sentry Deno SDK is
 * pinned in ADR 0001, so the sink posts one event per error to the project's envelope endpoint
 * with `fetch`, after `scrubEvent` has removed personal data. It has no dependencies, so Deno loads
 * it from the vendored platform bundle.
 */

import { scrubEvent, type ErrorSink, type SentryEventLike } from "./errors.ts";
import { identityFromEnv } from "./logger.ts";
import { redact, redactString } from "./redact.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** Default share of requests traced (ADR 0025, Sentry Developer plan). */
export const DEFAULT_TRACES_SAMPLE_RATE = 0.05;

/** The server DSN: `SENTRY_DSN`, else the public `NEXT_PUBLIC_SENTRY_DSN`. Blank counts as unset. */
export function sentryDsn(env: Env): string | undefined {
  for (const name of ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"]) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** `XOS_TRACES_SAMPLE_RATE` as a number in [0, 1]; anything else falls back to 0.05. */
export function tracesSampleRate(env: Env): number {
  const raw = env["XOS_TRACES_SAMPLE_RATE"]?.trim();
  if (!raw) return DEFAULT_TRACES_SAMPLE_RATE;
  const rate = Number(raw);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : DEFAULT_TRACES_SAMPLE_RATE;
}

export interface SentryInitOptions {
  readonly dsn: string;
  readonly environment: string;
  readonly release?: string;
  readonly tracesSampleRate: number;
  readonly sendDefaultPii: false;
  readonly beforeSend: typeof scrubEvent;
  readonly beforeSendTransaction: typeof scrubEvent;
}

/** Options for `Sentry.init`, or `undefined` when no DSN is configured. */
export function sentryInitOptions(service: string, env: Env): SentryInitOptions | undefined {
  const dsn = sentryDsn(env);
  if (dsn === undefined) return undefined;
  const identity = identityFromEnv(service, env);
  return {
    dsn,
    environment: identity.environment,
    ...(identity.release ? { release: identity.release } : {}),
    tracesSampleRate: tracesSampleRate(env),
    sendDefaultPii: false,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
  };
}

/** The parts of a DSN (`https://<key>@<host>/<project>`) the envelope endpoint needs. */
export interface ParsedDsn {
  readonly key: string;
  readonly origin: string;
  readonly projectId: string;
}

export function parseDsn(dsn: string): ParsedDsn | undefined {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
  const projectId = url.pathname.split("/").filter(Boolean).pop();
  if (url.protocol !== "https:" || !url.username || !projectId || !/^\d+$/.test(projectId)) {
    return undefined;
  }
  return { key: url.username, origin: url.origin, projectId };
}

export interface EnvelopeSink extends ErrorSink {
  /** Waits for events in flight, up to `timeoutMs`. True when every send settled in time. */
  flush(timeoutMs?: number): Promise<boolean>;
}

export interface EnvelopeSinkOptions {
  readonly service: string;
  readonly env: Env;
  readonly fetch?: typeof fetch;
  /** Called when a send fails; the error never reaches the request. */
  readonly onSendError?: (error: unknown) => void;
  readonly now?: () => Date;
}

const SDK_NAME = "xos.envelope";
const SDK_VERSION = "1.0.0";

function newEventId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function frames(stack: string | undefined): Array<Record<string, unknown>> | undefined {
  if (!stack) return undefined;
  const parsed: Array<Record<string, unknown>> = [];
  for (const line of stack.split("\n")) {
    const match = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!match) continue;
    const [, fn, file, lineno, colno] = match;
    parsed.push({
      function: fn ?? "?",
      filename: redactString(file ?? "?", 512),
      lineno: Number(lineno),
      colno: Number(colno),
      in_app: !(file ?? "").includes("node_modules"),
    });
  }
  // Sentry lists frames oldest first.
  return parsed.length > 0 ? parsed.reverse() : undefined;
}

/**
 * An error sink that sends scrubbed events to Sentry over HTTP. Returns `undefined` without a valid
 * DSN, so callers pass the result straight to `createObservability({ errorSink })`.
 */
export function createSentryEnvelopeSink(options: EnvelopeSinkOptions): EnvelopeSink | undefined {
  const dsnText = sentryDsn(options.env);
  const dsn = dsnText === undefined ? undefined : parseDsn(dsnText);
  if (dsn === undefined || dsnText === undefined) return undefined;
  const send = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const identity = identityFromEnv(options.service, options.env);
  const endpoint = `${dsn.origin}/api/${dsn.projectId}/envelope/`;
  const auth = `Sentry sentry_version=7, sentry_key=${dsn.key}, sentry_client=${SDK_NAME}/${SDK_VERSION}`;
  const pending = new Set<Promise<void>>();

  return {
    captureException(exception, hint) {
      const error = exception instanceof Error ? exception : new Error(String(exception));
      const stacktrace = frames(error.stack);
      const event: SentryEventLike & Record<string, unknown> = {
        event_id: newEventId(),
        timestamp: now().getTime() / 1000,
        platform: "javascript",
        level: "error",
        logger: identity.service,
        environment: identity.environment,
        ...(identity.release ? { release: identity.release } : {}),
        exception: {
          values: [
            {
              type: error.name,
              value: error.message,
              ...(stacktrace ? { stacktrace: { frames: stacktrace } } : {}),
            },
          ],
        },
        tags: { service: identity.service, ...hint?.tags },
        extra: redact(hint?.extra ?? {}) as Record<string, unknown>,
        ...(hint?.user ? { user: { id: hint.user.id } } : {}),
        sdk: { name: SDK_NAME, version: SDK_VERSION },
      };
      const scrubbed = scrubEvent(event);
      const body = [
        JSON.stringify({ event_id: scrubbed["event_id"], sent_at: now().toISOString() }),
        JSON.stringify({ type: "event" }),
        JSON.stringify(scrubbed),
      ].join("\n");
      const request = send(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": auth },
        body,
      }).then(
        (response) => {
          if (!response.ok) options.onSendError?.(new Error(`Sentry answered ${response.status}`));
        },
        (error: unknown) => options.onSendError?.(error),
      );
      pending.add(request);
      void request.finally(() => pending.delete(request));
      return scrubbed["event_id"];
    },
    async flush(timeoutMs = 2000) {
      if (pending.size === 0) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      const settled = Promise.allSettled([...pending]).then(() => true as const);
      const done = await Promise.race([settled, timeout]);
      clearTimeout(timer);
      return done;
    },
  };
}
