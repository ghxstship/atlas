import { describe, expect, it, vi } from "vitest";
import {
  REDACTED,
  SpanStatus,
  continueTrace,
  createErrorReporter,
  createLogger,
  createOnRequestError,
  detachedSpan,
  formatTraceparent,
  newSpanId,
  newTraceId,
  observe,
  parseTraceparent,
  requestIdFrom,
  withCorrelationHeaders,
  withSpan,
  type AttributeValue,
  type SpanLike,
  type SpanOptionsLike,
  type TracerLike,
} from "../src/index.ts";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";

describe("trace context", () => {
  it("parses and formats traceparent", () => {
    const ctx = parseTraceparent(`00-${TRACE}-${SPAN}-01`);
    expect(ctx).toEqual({ traceId: TRACE, spanId: SPAN, sampled: true });
    expect(formatTraceparent({ traceId: TRACE, spanId: SPAN, sampled: false })).toBe(
      `00-${TRACE}-${SPAN}-00`,
    );
  });

  it.each([
    null,
    undefined,
    "",
    "junk",
    `ff-${TRACE}-${SPAN}-01`,
    `00-${"0".repeat(32)}-${SPAN}-01`,
    `00-${TRACE}-${"0".repeat(16)}-01`,
  ])("rejects %s", (value) => {
    expect(parseTraceparent(value)).toBeNull();
  });

  it("continues a caller trace with a new span, or starts one", () => {
    const continued = continueTrace(`00-${TRACE}-${SPAN}-00`);
    expect(continued.traceId).toBe(TRACE);
    expect(continued.spanId).not.toBe(SPAN);
    expect(continued.sampled).toBe(false);
    const fresh = continueTrace(null);
    expect(fresh.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(fresh.sampled).toBe(true);
    expect(newTraceId()).toHaveLength(32);
    expect(newSpanId()).toHaveLength(16);
  });

  it("takes a well formed platform request id or issues one", () => {
    expect(requestIdFrom(new Headers({ "x-vercel-id": "iad1::abcd-1234" }))).toBe(
      "iad1::abcd-1234",
    );
    expect(requestIdFrom(new Headers({ "x-request-id": "bad id with spaces" }))).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });
});

/** A recording tracer with the OpenTelemetry startActiveSpan shape. */
function recordingTracer() {
  const spans: Array<{
    name: string;
    options: SpanOptionsLike;
    attributes: Record<string, AttributeValue>;
    status?: { code: number; message?: string };
    exceptions: unknown[];
    ended: boolean;
  }> = [];
  const tracer: TracerLike = {
    startActiveSpan(name, options, fn) {
      const record = {
        name,
        options,
        attributes: { ...options.attributes },
        exceptions: [] as unknown[],
        ended: false,
      } as (typeof spans)[number];
      spans.push(record);
      const span: SpanLike = {
        setAttribute: (k, v) => {
          record.attributes[k] = v;
        },
        setStatus: (s) => {
          record.status = s;
        },
        recordException: (e) => {
          record.exceptions.push(e);
        },
        end: () => {
          record.ended = true;
        },
        spanContext: () => ({ traceId: TRACE, spanId: "1111111111111111", traceFlags: 1 }),
      };
      return fn(span) as ReturnType<typeof fn>;
    },
  };
  return { tracer, spans };
}

describe("withSpan", () => {
  it("records redacted attributes, success and failure on a real tracer", async () => {
    const { tracer, spans } = recordingTracer();
    await expect(
      withSpan("ok", { tracer, attributes: { "user.email": "a@b.co", n: 1 } }, () => 5),
    ).resolves.toBe(5);
    await expect(
      withSpan("bad", { tracer }, () => {
        throw new Error("fail for a@b.co");
      }),
    ).rejects.toThrow("fail for a@b.co");
    await expect(
      withSpan("str", { tracer }, () => {
        throw "plain";
      }),
    ).rejects.toBe("plain");
    expect(spans[0]).toMatchObject({
      name: "ok",
      attributes: { "user.email": REDACTED, n: 1 },
      ended: true,
    });
    expect(spans[1]?.status).toEqual({ code: SpanStatus.ERROR, message: "fail for [email]" });
    expect(spans[1]?.exceptions[0]).toMatchObject({ name: "Error", message: "fail for [email]" });
    expect(spans[2]?.status).toMatchObject({ message: "plain" });
  });

  it("runs without a tracer and keeps the parent ids", async () => {
    const parent = { traceId: TRACE, spanId: SPAN, sampled: false };
    const ctx = await withSpan("x", { parent }, (span) => span.spanContext());
    expect(ctx).toEqual({ traceId: TRACE, spanId: SPAN, traceFlags: 0 });
    const span = detachedSpan();
    span.setAttribute("a", 1);
    span.setStatus({ code: 0 });
    span.recordException({ name: "n", message: "m" });
    span.end();
    expect(span.spanContext().traceFlags).toBe(1);
  });
});

function setup(tracer?: TracerLike) {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    service: "api",
    environment: "test",
    sink: (line: string) => lines.push(JSON.parse(line)),
  });
  const captureException = vi.fn();
  const errors = createErrorReporter({ logger, sink: { captureException } });
  let clock = 0;
  const now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
  };
  return { lines, logger, errors, captureException, now, advance, tracer };
}

describe("observe", () => {
  it("logs completion with correlation ids and echoes them on the response", async () => {
    const s = setup();
    const handler = observe(
      (_req, scope) => {
        scope.logger.info("handling", { email: "a@b.co" });
        s.advance(12);
        return new Response("ok", { status: 200 });
      },
      { logger: s.logger, errors: s.errors, route: "/api/v1/projects", now: s.now },
    );
    const res = await handler(
      new Request("https://atlas.test/api/v1/projects?email=a@b.co", {
        headers: { traceparent: `00-${TRACE}-${SPAN}-01`, "x-request-id": "req-12345678" },
      }),
    );
    expect(res.headers.get("x-request-id")).toBe("req-12345678");
    expect(parseTraceparent(res.headers.get("traceparent"))?.traceId).toBe(TRACE);
    expect(s.lines[0]).toMatchObject({
      message: "handling",
      email: REDACTED,
      trace_id: TRACE,
      request_id: "req-12345678",
    });
    expect(s.lines[1]).toMatchObject({
      message: "request completed",
      method: "GET",
      path: "/api/v1/projects",
      status: 200,
      duration_ms: 12,
      http_route: "/api/v1/projects",
    });
  });

  it("logs slow requests at warn and 5xx at error, and uses the tracer span ids", async () => {
    const { tracer, spans } = recordingTracer();
    const s = setup(tracer);
    const slow = observe(
      () => {
        s.advance(900);
        return new Response(null, { status: 204 });
      },
      { logger: s.logger, errors: s.errors, tracer, route: "/slow", now: s.now },
    );
    const failing = observe(() => new Response("no", { status: 503 }), {
      logger: s.logger,
      errors: s.errors,
      tracer,
      route: "/down",
      now: s.now,
    });
    await slow(new Request("https://atlas.test/slow"));
    await failing(new Request("https://atlas.test/down", { method: "post" }));
    expect(s.lines.map((l) => [l["level"], l["message"]])).toEqual([
      ["warn", "request slow"],
      ["error", "request failed"],
    ]);
    expect(s.lines[0]).toMatchObject({ span_id: "1111111111111111" });
    expect(spans[1]).toMatchObject({
      name: "POST /down",
      attributes: { "http.response.status_code": 503 },
      status: { code: SpanStatus.ERROR },
    });
  });

  it("reports a thrown error once and rethrows it", async () => {
    const s = setup();
    const boom = new Error("db down");
    const handler = observe(
      () => {
        throw boom;
      },
      { logger: s.logger, errors: s.errors, route: "/x" },
    );
    await expect(handler(new Request("https://atlas.test/x"))).rejects.toBe(boom);
    expect(s.captureException).toHaveBeenCalledTimes(1);
    expect(s.lines.map((l) => l["message"])).toEqual(["unhandled error", "request threw"]);
    const onRequestError = createOnRequestError(s.errors);
    await onRequestError(
      boom,
      { path: "/x", method: "GET", headers: {} },
      { routerKind: "App Router", routePath: "/x", routeType: "route" },
    );
    expect(s.captureException).toHaveBeenCalledTimes(1);
  });

  it("copies a response whose headers are immutable", () => {
    const immutable = Response.redirect("https://atlas.test/next", 302);
    const out = withCorrelationHeaders(
      immutable,
      { traceId: TRACE, spanId: SPAN, sampled: true },
      "req-1",
    );
    expect(out).not.toBe(immutable);
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe("https://atlas.test/next");
    expect(out.headers.get("x-request-id")).toBe("req-1");
  });

  it("rethrows unexpected header errors", () => {
    const res = new Response("x");
    Object.defineProperty(res, "headers", {
      value: {
        set: () => {
          throw new RangeError("odd");
        },
      },
    });
    expect(() =>
      withCorrelationHeaders(res, { traceId: TRACE, spanId: SPAN, sampled: true }, "r"),
    ).toThrow(RangeError);
  });
});

describe("createOnRequestError", () => {
  it("reports framework errors with route tags and a redacted path", async () => {
    const s = setup();
    const onRequestError = createOnRequestError(s.errors);
    const error = new Error("render failed");
    await onRequestError(
      error,
      {
        path: "/acme/projects?email=a@b.co",
        method: "GET",
        headers: { traceparent: [`00-${TRACE}-${SPAN}-01`], "x-vercel-id": "iad1::xyz" },
      },
      {
        routerKind: "App Router",
        routePath: "/[org]/projects",
        routeType: "render",
        renderSource: "react-server-components",
      },
    );
    expect(s.captureException).toHaveBeenCalledWith(error, {
      tags: {
        route: "/[org]/projects",
        route_type: "render",
        router: "App Router",
        render_source: "react-server-components",
      },
      extra: { method: "GET", path: "/acme/projects", trace_id: TRACE, request_id: "iad1::xyz" },
    });
  });
});
