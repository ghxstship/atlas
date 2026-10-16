import { describe, expect, it } from "vitest";
import {
  CHECKS,
  emptyHistory,
  errorDetail,
  failingRequired,
  formatAlerts,
  parseHistory,
  recordRun,
  runChecks,
  type CheckDefinition,
  type CheckResult,
  type WebSocketLike,
} from "../src/index.ts";

function check(index: number): CheckDefinition {
  const found = CHECKS[index];
  if (!found) throw new Error(`no check ${index}`);
  return found;
}

const ENV = {
  XOS_ATLAS_URL: "https://atlas.test/",
  XOS_GATEWAY_URL: "https://gateway.test",
  SUPABASE_URL: "https://ref.supabase.test",
  SUPABASE_ANON_KEY: "anon",
  XOS_SYNTHETIC_EMAIL: "synthetic@xos.test",
  XOS_SYNTHETIC_PASSWORD: "pw",
  XOS_POWERSYNC_URL: "https://sync.test",
};

type Route = (init: RequestInit | undefined) => Response;

function fakeFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    return (routes[key] as Route)(init);
  }) as typeof fetch;
  return { impl, calls };
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html" } });
const json = (body: unknown, status = 200) => Response.json(body, { status });

function healthyRoutes(): Record<string, Route> {
  return {
    "https://atlas.test/auth/sign-in": () => html("<html><form method=post></form></html>"),
    "https://ref.supabase.test/auth/v1/token": () => json({ access_token: "jwt-token" }),
    "https://gateway.test/": () => html("<!doctype html><html lang=en></html>"),
    "https://atlas.test/api/v1/openapi.json": () => json({ openapi: "3.1.1" }),
    "https://atlas.test/api/v1/projects": () => json({ data: [] }),
    "https://sync.test/probes/liveness": () => new Response("ok"),
    "https://sync.test/probes/readiness": () => new Response("ok"),
    "https://ref.supabase.test/functions/v1/notification-dispatch": () => json({}, 401),
  };
}

function fakeSocket(reply: string | null, mode: "reply" | "error" | "close" | "silent" = "reply") {
  const sent: string[] = [];
  let url = "";
  const open = (u: string): WebSocketLike => {
    url = u;
    const socket: WebSocketLike = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: (data) => {
        sent.push(data);
        if (mode === "reply" && reply !== null)
          queueMicrotask(() => socket.onmessage?.({ data: reply }));
      },
      close: () => undefined,
    };
    queueMicrotask(() => {
      if (mode === "error") socket.onerror?.({});
      else if (mode === "close") socket.onclose?.({});
      else socket.onopen?.({});
    });
    return socket;
  };
  return { open, sent, url: () => url };
}

const okReply = JSON.stringify({ event: "phx_reply", ref: "1", payload: { status: "ok" } });

function clock(step = 10) {
  let t = Date.parse("2026-10-16T12:00:00Z");
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

describe("runChecks", () => {
  it("passes every check against a healthy deployment and reuses one sign-in", async () => {
    const f = fakeFetch(healthyRoutes());
    const ws = fakeSocket(okReply);
    const results = await runChecks(CHECKS, {
      env: ENV,
      region: "us-east",
      fetch: f.impl,
      openWebSocket: ws.open,
      now: clock(1),
    });
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ["atlas.sign_in_page", "pass"],
      ["atlas.sign_in", "pass"],
      ["gateway.home", "pass"],
      ["api.openapi", "pass"],
      ["api.read", "pass"],
      ["realtime.join", "pass"],
      ["sync.liveness", "pass"],
      ["notifications.function", "pass"],
    ]);
    expect(f.calls.filter((c) => c.url.includes("/auth/v1/token"))).toHaveLength(1);
    const read = f.calls.find((c) => c.url.includes("/api/v1/projects"));
    expect((read?.init?.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer jwt-token",
    );
    expect(ws.url()).toBe("wss://ref.supabase.test/realtime/v1/websocket?apikey=anon&vsn=1.0.0");
    expect(JSON.parse(ws.sent[0] ?? "")).toMatchObject({
      event: "phx_join",
      topic: "realtime:xos-synthetics",
    });
    expect(results[0]).toMatchObject({
      region: "us-east",
      runbook: expect.stringContaining("incident-response.md#"),
    });
  });

  it("skips checks whose configuration is missing", async () => {
    const results = await runChecks(CHECKS, { env: {}, region: "us-east" });
    expect(new Set(results.map((r) => r.status))).toEqual(new Set(["skipped"]));
    expect(results[0]?.detail).toBe("missing_XOS_ATLAS_URL");
    expect(results[0]?.latencyMs).toBeNull();
  });

  it("marks slow correct answers degraded", async () => {
    const f = fakeFetch(healthyRoutes());
    const results = await runChecks([check(3)], {
      env: ENV,
      region: "us-east",
      fetch: f.impl,
      now: clock(300),
    });
    expect(results[0]).toMatchObject({ status: "degraded", detail: "over_budget_250ms" });
  });

  it("reports wrong answers and errors as failures", async () => {
    const routes = healthyRoutes();
    routes["https://atlas.test/auth/sign-in"] = () => html("<html>no form</html>");
    routes["https://ref.supabase.test/auth/v1/token"] = () => json({ error: "invalid_grant" }, 400);
    routes["https://gateway.test/"] = () => json({});
    routes["https://atlas.test/api/v1/openapi.json"] = () => json({ openapi: "3.0.0" });
    routes["https://sync.test/probes/readiness"] = () => new Response("no", { status: 503 });
    routes["https://ref.supabase.test/functions/v1/notification-dispatch"] = () => json({}, 500);
    const f = fakeFetch(routes);
    const ws = fakeSocket(
      JSON.stringify({ event: "phx_reply", ref: "1", payload: { status: "error" } }),
    );
    const results = await runChecks(CHECKS, {
      env: ENV,
      region: "us-east",
      fetch: f.impl,
      openWebSocket: ws.open,
      now: clock(1),
    });
    expect(results.map((r) => [r.id, r.status, r.detail])).toEqual([
      ["atlas.sign_in_page", "fail", "sign_in_form_missing"],
      ["atlas.sign_in", "fail", "status_400"],
      ["gateway.home", "fail", "not_html"],
      ["api.openapi", "fail", "not_openapi_3_1"],
      ["api.read", "fail", "status_400"],
      ["realtime.join", "fail", "join_error"],
      ["sync.liveness", "fail", "readiness_status_503"],
      ["notifications.function", "fail", "status_500"],
    ]);
    expect(failingRequired(CHECKS, results).map((r) => r.id)).not.toContain(
      "notifications.function",
    );
  });

  it("covers the remaining failure shapes", async () => {
    const routes = healthyRoutes();
    routes["https://atlas.test/auth/sign-in"] = () => html("", 503);
    routes["https://ref.supabase.test/auth/v1/token"] = () => json({ access_token: "" });
    routes["https://gateway.test/"] = () => html("", 500);
    routes["https://atlas.test/api/v1/openapi.json"] = () => json({}, 404);
    routes["https://sync.test/probes/liveness"] = () => new Response("", { status: 500 });
    const f = fakeFetch(routes);
    const results = await runChecks(CHECKS.slice(0, 5).concat(check(6)), {
      env: ENV,
      region: "us-east",
      fetch: f.impl,
      now: clock(1),
    });
    expect(results.map((r) => r.detail)).toEqual([
      "status_503",
      "no_access_token",
      "status_500",
      "status_404",
      "no_access_token",
      "liveness_status_500",
    ]);
    const projects = healthyRoutes();
    projects["https://atlas.test/api/v1/projects"] = () => json({ items: [] });
    const shape = await runChecks([check(4)], {
      env: ENV,
      region: "r",
      fetch: fakeFetch(projects).impl,
    });
    expect(shape[0]?.detail).toBe("no_data_array");
    const down = healthyRoutes();
    down["https://atlas.test/api/v1/projects"] = () => json({}, 503);
    const status = await runChecks([check(4)], {
      env: ENV,
      region: "r",
      fetch: fakeFetch(down).impl,
    });
    expect(status[0]?.detail).toBe("status_503");
  });

  it("turns network errors, socket errors and timeouts into failures", async () => {
    const f = fakeFetch({});
    const results = await runChecks([check(0)], { env: ENV, region: "us-east", fetch: f.impl });
    expect(results[0]).toMatchObject({ status: "fail", detail: "network_enotfound" });
    for (const [mode, detail] of [
      ["error", "socket_error"],
      ["close", "socket_closed"],
    ] as const) {
      const ws = fakeSocket(null, mode);
      const r = await runChecks([check(5)], {
        env: ENV,
        region: "us-east",
        openWebSocket: ws.open,
      });
      expect(r[0]?.detail).toBe(detail);
    }
    const silent = fakeSocket(null, "silent");
    const timedOut = await runChecks([check(5)], {
      env: ENV,
      region: "us-east",
      openWebSocket: silent.open,
      timeoutMs: 5,
    });
    expect(timedOut[0]?.detail).toBe("join_timeout");
    const garbage = fakeSocket("not json");
    const bad = await runChecks([check(5)], {
      env: ENV,
      region: "us-east",
      openWebSocket: garbage.open,
    });
    expect(bad[0]?.detail).toBe("bad_frame_SyntaxError");
    const other = fakeSocket(JSON.stringify({ event: "presence_state", ref: null }));
    const ignored = await runChecks([check(5)], {
      env: ENV,
      region: "us-east",
      openWebSocket: other.open,
      timeoutMs: 5,
    });
    expect(ignored[0]?.detail).toBe("join_timeout");
    const noStatus = fakeSocket(JSON.stringify({ event: "phx_reply", ref: "1", payload: {} }));
    const unknown = await runChecks([check(5)], {
      env: ENV,
      region: "us-east",
      openWebSocket: noStatus.open,
    });
    expect(unknown[0]?.detail).toBe("join_unknown");
  });

  it("uses the global WebSocket when none is injected", async () => {
    const original = (globalThis as { WebSocket?: unknown }).WebSocket;
    const ws = fakeSocket(okReply);
    (globalThis as { WebSocket?: unknown }).WebSocket = function (this: unknown, url: string) {
      return ws.open(url);
    };
    const r = await runChecks([check(5)], { env: ENV, region: "us-east" });
    expect(r[0]?.status).toBe("pass");
    (globalThis as { WebSocket?: unknown }).WebSocket = undefined;
    const missing = await runChecks([check(5)], { env: ENV, region: "us-east" });
    expect(missing[0]?.detail).toBe("error_error");
    (globalThis as { WebSocket?: unknown }).WebSocket = original;
  });

  it("describes errors without their messages", () => {
    expect(errorDetail(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("timeout");
    expect(errorDetail(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("timeout");
    expect(errorDetail(new TypeError("leak ada@example.com"))).toBe("error_typeerror");
    expect(errorDetail("text")).toBe("error_unknown");
  });

  it("never lets a probe that throws escape", async () => {
    const throwing: CheckDefinition = {
      id: "x",
      component: "api",
      requires: [],
      budgetMs: 1,
      required: true,
      runbook: "r",
      probe: () => Promise.reject(new RangeError("boom")),
    };
    const results = await runChecks([throwing], { env: {}, region: "us-east" });
    expect(results[0]).toMatchObject({ status: "fail", detail: "error_rangeerror" });
  });
});

describe("alerts", () => {
  it("formats one line per failure with its runbook", () => {
    const result: CheckResult = {
      id: "api.read",
      component: "api",
      region: "us-east",
      status: "fail",
      latencyMs: 12,
      detail: "status_503",
      at: "2026-10-16T12:00:00.000Z",
      runbook: "infra/runbooks/incident-response.md#api-errors-or-latency",
    };
    expect(
      formatAlerts(
        [
          result,
          { ...result, id: "ok", status: "pass" },
          { ...result, detail: null, latencyMs: null },
        ],
        "https://github.com/ghxstship/atlas",
      ),
    ).toEqual([
      "[us-east] api.read (api) failed: status_503 after 12 ms. Runbook: https://github.com/ghxstship/atlas/blob/main/infra/runbooks/incident-response.md#api-errors-or-latency",
      "[us-east] api.read (api) failed: unknown after 0 ms. Runbook: https://github.com/ghxstship/atlas/blob/main/infra/runbooks/incident-response.md#api-errors-or-latency",
    ]);
  });
});

describe("history", () => {
  const base = (status: CheckResult["status"], at: string): CheckResult => ({
    id: "api.read",
    component: "api",
    region: "us-east",
    status,
    latencyMs: status === "skipped" ? null : 10,
    detail: null,
    at,
    runbook: "r",
  });

  it("counts results per day, keeps the last real result and drops old days", () => {
    let h = emptyHistory();
    h = recordRun(h, [base("skipped", "2026-07-01T00:00:00Z")], new Date("2026-07-01T00:00:00Z"));
    expect(h.regions["us-east"]?.["api.read"]?.last?.status).toBe("skipped");
    h = recordRun(h, [base("pass", "2026-07-01T00:05:00Z")], new Date("2026-07-01T00:05:00Z"));
    h = recordRun(
      h,
      [base("fail", "2026-10-16T00:00:00Z"), base("degraded", "2026-10-16T00:05:00Z")],
      new Date("2026-10-16T00:05:00Z"),
    );
    h = recordRun(h, [base("skipped", "2026-10-16T00:10:00Z")], new Date("2026-10-16T00:10:00Z"));
    const entry = h.regions["us-east"]?.["api.read"];
    expect(entry?.days).toEqual({ "2026-10-16": { pass: 0, degraded: 1, fail: 1 } });
    expect(entry?.last?.status).toBe("degraded");
    expect(h.updatedAt).toBe("2026-10-16T00:10:00.000Z");
  });

  it("parses only version 1 history", () => {
    expect(parseHistory(null)).toEqual(emptyHistory());
    expect(parseHistory(JSON.stringify({ version: 1, regions: {} }))).toEqual({
      version: 1,
      updatedAt: null,
      regions: {},
    });
    expect(() => parseHistory(JSON.stringify({ version: 2, regions: {} }))).toThrow(
      "not version 1",
    );
    expect(() => parseHistory(JSON.stringify({ version: 1 }))).toThrow("not version 1");
  });
});
