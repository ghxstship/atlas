import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TRACES_SAMPLE_RATE,
  KEPT_REQUEST_HEADERS,
  SENTRY_DATA_COLLECTION,
  createSentryEnvelopeSink,
  parseDsn,
  scrubEvent,
  sentryDsn,
  sentryInitOptions,
  tracesSampleRate,
} from "../src/index.ts";

/** The value, or a thrown error naming what was missing. */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a value");
  return value;
}

const DSN = "https://publickey@o123.ingest.us.sentry.io/4500000000000001";

describe("sentryDsn and sentryInitOptions", () => {
  it("prefers SENTRY_DSN, falls back to NEXT_PUBLIC_SENTRY_DSN, and treats blank as unset", () => {
    expect(sentryDsn({ SENTRY_DSN: "a", NEXT_PUBLIC_SENTRY_DSN: "b" })).toBe("a");
    expect(sentryDsn({ SENTRY_DSN: " ", NEXT_PUBLIC_SENTRY_DSN: "b" })).toBe("b");
    expect(sentryDsn({})).toBeUndefined();
  });

  it("returns nothing without a DSN, so the apps skip Sentry.init", () => {
    expect(sentryInitOptions("atlas", { NODE_ENV: "test" })).toBeUndefined();
  });

  it("builds the init options with scrubbing, no default PII and the sample rate", () => {
    const options = sentryInitOptions("atlas", {
      NEXT_PUBLIC_SENTRY_DSN: DSN,
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_SHA: "abc123",
      XOS_TRACES_SAMPLE_RATE: "1",
    });
    expect(options).toEqual({
      dsn: DSN,
      environment: "preview",
      release: "abc123",
      tracesSampleRate: 1,
      dataCollection: SENTRY_DATA_COLLECTION,
      beforeSend: scrubEvent,
      beforeSendTransaction: scrubEvent,
    });
  });

  // A69-012: Sentry 11 ignores sendDefaultPii and collects everything unless dataCollection says not to.
  it("switches off what the SDK collects on its own, keeping only the scrubbed request headers", () => {
    expect(SENTRY_DATA_COLLECTION).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: [...KEPT_REQUEST_HEADERS] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    });
    expect(KEPT_REQUEST_HEADERS).not.toContain("next-router-state-tree");
  });

  it("reads XOS_TRACES_SAMPLE_RATE, defaulting to 0.05 when unset or out of range", () => {
    expect(tracesSampleRate({})).toBe(DEFAULT_TRACES_SAMPLE_RATE);
    expect(tracesSampleRate({ XOS_TRACES_SAMPLE_RATE: "0.2" })).toBe(0.2);
    expect(tracesSampleRate({ XOS_TRACES_SAMPLE_RATE: "2" })).toBe(0.05);
    expect(tracesSampleRate({ XOS_TRACES_SAMPLE_RATE: "lots" })).toBe(0.05);
  });
});

describe("parseDsn", () => {
  it("splits a DSN into key, origin and project", () => {
    expect(parseDsn(DSN)).toEqual({
      key: "publickey",
      origin: "https://o123.ingest.us.sentry.io",
      projectId: "4500000000000001",
    });
  });

  it("rejects malformed and non-https DSNs", () => {
    expect(parseDsn("not a url")).toBeUndefined();
    expect(parseDsn("http://k@host/1")).toBeUndefined();
    expect(parseDsn("https://host/1")).toBeUndefined();
    expect(parseDsn("https://k@host/project")).toBeUndefined();
  });
});

describe("createSentryEnvelopeSink", () => {
  it("is undefined without a valid DSN, so Edge Functions without the secret send nothing", () => {
    const fetchSpy = vi.fn();
    expect(
      createSentryEnvelopeSink({ service: "edge.x", env: {}, fetch: fetchSpy }),
    ).toBeUndefined();
    expect(
      createSentryEnvelopeSink({ service: "edge.x", env: { SENTRY_DSN: "nope" }, fetch: fetchSpy }),
    ).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts one scrubbed event envelope per error", async () => {
    const fetchSpy = vi.fn(
      async (url: string, init: RequestInit) =>
        new Response(null, { status: url && init ? 200 : 500 }),
    );
    const sink = must(
      createSentryEnvelopeSink({
        service: "edge.kiosk-punch",
        env: { SENTRY_DSN: DSN, XOS_ENVIRONMENT: "staging", XOS_RELEASE: "r1" },
        fetch: fetchSpy as unknown as typeof fetch,
        now: () => new Date("2026-10-16T12:00:00.000Z"),
      }),
    );
    const error = new Error("insert failed for ada@example.com");
    error.stack = [
      "Error: insert failed",
      "    at punch (file:///src/kiosk-punch/index.ts:10:5)",
      "    at async serve (file:///node_modules/x/index.js:1:1)",
    ].join("\n");
    const id = sink.captureException(error, {
      tags: { function: "kiosk-punch" },
      extra: { email: "ada@example.com", request_id: "req-1" },
      user: { id: "4f1c2e7a-0000-4000-8000-000000000001" },
    });
    expect(await sink.flush()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = must(fetchSpy.mock.calls[0]);
    expect(url).toBe("https://o123.ingest.us.sentry.io/api/4500000000000001/envelope/");
    expect((init.headers as Record<string, string>)["X-Sentry-Auth"]).toContain(
      "sentry_key=publickey",
    );
    const [header, item, eventLine] = String(init.body).split("\n");
    expect(JSON.parse(must(header))).toEqual({ event_id: id, sent_at: "2026-10-16T12:00:00.000Z" });
    expect(JSON.parse(must(item))).toEqual({ type: "event" });
    const event = JSON.parse(must(eventLine));
    expect(event).toMatchObject({
      environment: "staging",
      release: "r1",
      level: "error",
      tags: { service: "edge.kiosk-punch", function: "kiosk-punch" },
      extra: { email: "[redacted]", request_id: "req-1" },
      user: { id: "4f1c2e7a-0000-4000-8000-000000000001" },
    });
    expect(event.exception.values[0].value).toBe("insert failed for [email]");
    expect(event.exception.values[0].stacktrace.frames).toEqual([
      {
        function: "async serve",
        filename: "file:///node_modules/x/index.js",
        lineno: 1,
        colno: 1,
        in_app: false,
      },
      {
        function: "punch",
        filename: "file:///src/kiosk-punch/index.ts",
        lineno: 10,
        colno: 5,
        in_app: true,
      },
    ]);
    expect(String(init.body)).not.toContain("ada@example.com");
  });

  it("reports send failures to onSendError and never throws into the caller", async () => {
    const onSendError = vi.fn();
    const failing = must(
      createSentryEnvelopeSink({
        service: "edge.x",
        env: { SENTRY_DSN: DSN },
        fetch: (async () => new Response(null, { status: 429 })) as typeof fetch,
        onSendError,
      }),
    );
    failing.captureException("a string error");
    await failing.flush();
    const rejecting = must(
      createSentryEnvelopeSink({
        service: "edge.x",
        env: { SENTRY_DSN: DSN },
        fetch: (async () => {
          throw new TypeError("network down");
        }) as typeof fetch,
        onSendError,
      }),
    );
    rejecting.captureException(new Error("x"));
    await rejecting.flush();
    expect(onSendError).toHaveBeenCalledTimes(2);
    expect(String(must(onSendError.mock.calls[0])[0])).toContain("429");
  });

  it("flush resolves false when a send outlasts the timeout, and true when idle", async () => {
    const sink = must(
      createSentryEnvelopeSink({
        service: "edge.x",
        env: { SENTRY_DSN: DSN },
        fetch: (() => new Promise<Response>(() => undefined)) as typeof fetch,
      }),
    );
    expect(await sink.flush()).toBe(true);
    sink.captureException(new Error("slow"));
    expect(await sink.flush(10)).toBe(false);
  });
});
