import { describe, expect, it, vi } from "vitest";
import {
  REDACTED,
  createErrorReporter,
  createLogger,
  createObservability,
  identityFromEnv,
  isLogLevel,
  safeStringify,
  scrubEvent,
  type LogLevel,
  type SentryEventLike,
} from "../src/index.ts";

function capture() {
  const lines: Array<{ level: LogLevel; record: Record<string, unknown> }> = [];
  const sink = (line: string, level: LogLevel) => lines.push({ level, record: JSON.parse(line) });
  return { lines, sink };
}

const fixed = () => new Date("2026-10-14T12:00:00.000Z");

describe("createLogger", () => {
  it("writes one redacted JSON record per event with the service identity", () => {
    const { lines, sink } = capture();
    const logger = createLogger({
      service: "atlas",
      environment: "test",
      release: "abc",
      region: "iad1",
      sink,
      now: fixed,
    });
    logger.info("signed in ada@example.com", {
      org_id: "o1",
      email: "ada@example.com",
      level: "custom",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.record).toEqual({
      timestamp: "2026-10-14T12:00:00.000Z",
      level: "info",
      message: "signed in [email]",
      service: "atlas",
      environment: "test",
      release: "abc",
      region: "iad1",
      org_id: "o1",
      email: REDACTED,
      fields: { level: "custom" },
    });
  });

  it("filters below the threshold and binds child fields", () => {
    const { lines, sink } = capture();
    const logger = createLogger({
      service: "gateway",
      environment: "test",
      level: "warn",
      sink,
      now: fixed,
    });
    logger.debug("d");
    logger.info("i");
    const child = logger.child({ request_id: "r1" });
    child.warn("w", { extra: 1 });
    child.error("e");
    expect(lines.map((l) => l.level)).toEqual(["warn", "error"]);
    expect(lines[0]?.record).toMatchObject({ request_id: "r1", extra: 1 });
    expect(child.identity.service).toBe("gateway");
  });

  it("defaults to stdout and stderr", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = createLogger({ service: "s", environment: "test", level: "debug" });
    logger.debug("a");
    logger.error("b");
    expect(log).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1);
    log.mockRestore();
    err.mockRestore();
  });
});

describe("helpers", () => {
  it("safeStringify never throws", () => {
    expect(safeStringify({ a: 1 })).toBe('{"a":1}');
    expect(JSON.parse(safeStringify({ big: 1n }))).toMatchObject({
      message: "log record could not be serialized",
    });
  });

  it("isLogLevel", () => {
    expect(isLogLevel("warn")).toBe(true);
    expect(isLogLevel("loud")).toBe(false);
  });

  it("identityFromEnv reads Vercel and Supabase variables", () => {
    expect(
      identityFromEnv("atlas", {
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_SHA: "sha",
        VERCEL_REGION: "iad1",
      }),
    ).toEqual({
      service: "atlas",
      environment: "preview",
      release: "sha",
      region: "iad1",
    });
    expect(identityFromEnv("edge.notify", { SB_REGION: "us-east-1" })).toEqual({
      service: "edge.notify",
      environment: "development",
      region: "us-east-1",
    });
    expect(identityFromEnv("x", { XOS_ENVIRONMENT: "staging", XOS_RELEASE: "v4" })).toEqual({
      service: "x",
      environment: "staging",
      release: "v4",
    });
  });
});

describe("createErrorReporter", () => {
  it("logs, forwards once and redacts extra", () => {
    const { lines, sink } = capture();
    const logger = createLogger({ service: "atlas", environment: "test", sink, now: fixed });
    const captureException = vi.fn();
    const reporter = createErrorReporter({ logger, sink: { captureException } });
    const error = new Error("boom for ada@example.com");
    reporter.report(error, { tags: { route: "/x" }, extra: { email: "ada@example.com", step: 2 } });
    reporter.report(error);
    expect(reporter.wasReported(error)).toBe(true);
    expect(reporter.wasReported(new Error("other"))).toBe(false);
    expect(reporter.wasReported("text")).toBe(false);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(error, {
      tags: { route: "/x" },
      extra: { email: REDACTED, step: 2 },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.record).toMatchObject({
      level: "error",
      error: { message: "boom for [email]" },
      step: 2,
    });
  });

  it("reports non-object throws every time and survives a failing sink", () => {
    const { lines, sink } = capture();
    const logger = createLogger({ service: "atlas", environment: "test", sink, now: fixed });
    const reporter = createErrorReporter({
      logger,
      sink: {
        captureException: () => {
          throw new Error("sink down");
        },
      },
    });
    reporter.report("string failure");
    reporter.report("string failure");
    expect(lines.map((l) => l.record["message"])).toEqual([
      "unhandled error",
      "error sink rejected an event",
      "unhandled error",
      "error sink rejected an event",
    ]);
  });

  it("works without a sink", () => {
    const { lines, sink } = capture();
    const obs = createObservability({
      service: "api",
      env: { XOS_LOG_LEVEL: "error" },
      sink: (l) => sink(l, "error"),
    });
    obs.logger.info("hidden");
    obs.errors.report(new Error("x"));
    expect(lines).toHaveLength(1);
    expect(obs.tracer).toBeUndefined();
  });
});

describe("scrubEvent", () => {
  it("removes personal data from a Sentry event", () => {
    const event: SentryEventLike = {
      message: "failed for ada@example.com",
      exception: { values: [{ type: "Error", value: "card 4111111111111111" }, { type: "Error" }] },
      request: {
        url: "https://atlas.test/auth/callback?code=secret",
        method: "GET",
        headers: {
          Cookie: "sb=1",
          Authorization: "Bearer x",
          traceparent: "00-a-b-01",
          "User-Agent": "UA",
        },
        cookies: { sb: "1" },
        data: { password: "x" },
        query_string: "code=secret",
        env: { REMOTE_ADDR: "203.0.113.9" },
      },
      user: { id: "p1", email: "ada@example.com", ip_address: "203.0.113.9", username: "ada" },
      breadcrumbs: [
        { message: "fetch ada@example.com", data: { email: "a@b.co" } },
        { category: "nav" },
      ],
      extra: { phone: "+14155550123" },
      contexts: { device: { ip: "203.0.113.9" } },
      tags: { email: "ada@example.com" },
      server_name: "host-1",
      transaction: "/auth/callback?code=secret",
    };
    const out = scrubEvent(event);
    expect(out).toEqual({
      message: "failed for [email]",
      exception: { values: [{ type: "Error", value: "card [card]" }, { type: "Error" }] },
      request: {
        url: "https://atlas.test/auth/callback",
        method: "GET",
        headers: { traceparent: "00-a-b-01" },
        data: REDACTED,
      },
      user: { id: "p1" },
      breadcrumbs: [{ message: "fetch [email]", data: { email: REDACTED } }, { category: "nav" }],
      extra: { phone: REDACTED },
      contexts: { device: { ip: REDACTED } },
      tags: { email: REDACTED },
      transaction: "/auth/callback",
    });
  });

  it("drops a user without an id and leaves minimal events alone", () => {
    expect(scrubEvent({ user: { email: "a@b.co" } })).toEqual({ user: {} });
    expect(scrubEvent({ request: { method: "GET" } })).toEqual({ request: { method: "GET" } });
  });
});
