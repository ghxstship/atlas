import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHECKS,
  CONFIRM_AFTER_FAILS,
  decideAlerts,
  emptyHistory,
  errorDetail,
  failingRequired,
  formatAlerts,
  parseHistory,
  postAlerts,
  recordRun,
  REMIND_EVERY_FAILS,
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
  XOS_API_URL: "https://api.test",
  XOS_DOCS_URL: "https://docs.test",
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
    "https://gateway.test/auth/sign-in": () => html("<!doctype html><html lang=en></html>"),
    "https://atlas.test/api/v1/openapi.json": () => json({ openapi: "3.1.1" }),
    "https://atlas.test/api/v1/projects": () => json({ data: [] }),
    "https://sync.test/probes/liveness": () => new Response("ok"),
    "https://sync.test/probes/readiness": () => new Response("ok"),
    "https://ref.supabase.test/functions/v1/notification-dispatch": () => json({}, 401),
    "https://api.test/v1/canon/departments": () =>
      new Response("{}", {
        status: 401,
        headers: { "content-type": "application/problem+json" },
      }),
    "https://docs.test/en-US": () => html("<!doctype html><html lang=en-US></html>"),
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
      ["api.host_guard", "pass"],
      ["docs.home", "pass"],
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

  it("runs only the public checks with the scheduled workflow's settings: no credential, no write", async () => {
    const f = fakeFetch(healthyRoutes());
    const results = await runChecks(CHECKS, {
      env: {
        XOS_ATLAS_URL: ENV.XOS_ATLAS_URL,
        XOS_GATEWAY_URL: ENV.XOS_GATEWAY_URL,
        XOS_API_URL: ENV.XOS_API_URL,
        XOS_DOCS_URL: ENV.XOS_DOCS_URL,
      },
      region: "us-east",
      fetch: f.impl,
      now: clock(1),
    });
    expect(results.filter((r) => r.status !== "skipped").map((r) => r.id)).toEqual([
      "atlas.sign_in_page",
      "gateway.home",
      "api.openapi",
      "api.host_guard",
      "docs.home",
    ]);
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
    expect(f.calls.map((c) => c.init?.method ?? "GET")).toEqual(Array(5).fill("GET"));
    for (const call of f.calls) {
      expect(call.init?.headers as Record<string, string>).not.toHaveProperty("authorization");
    }
  });

  it("wants a problem document from the API host's refusal", async () => {
    const routes = healthyRoutes();
    routes["https://api.test/v1/canon/departments"] = () => json({}, 401);
    const f = fakeFetch(routes);
    const results = await runChecks(
      CHECKS.filter((c) => c.id === "api.host_guard"),
      { env: ENV, region: "us-east", fetch: f.impl },
    );
    expect(results[0]).toMatchObject({ status: "fail", detail: "not_a_problem" });
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
      now: clock(700),
    });
    expect(results[0]).toMatchObject({ status: "degraded", detail: "over_budget_600ms" });
  });

  it("identifies the real OpenAPI document from its start, without downloading it", async () => {
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const file = readFileSync(`${repo}packages/api/openapi/v1.json`);
    // As committed, and compacted as the route serves it through Response.json.
    for (const document of [file, Buffer.from(JSON.stringify(JSON.parse(file.toString())))]) {
      let sent = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(document.subarray(sent, sent + 256));
          sent += 256;
        },
        cancel() {
          cancelled = true;
        },
      });
      const fetcher = (async () => new Response(body, { status: 200 })) as typeof fetch;
      const results = await runChecks([check(3)], {
        env: ENV,
        region: "us-east",
        fetch: fetcher,
      });
      expect(results[0]?.status).toBe("pass");
      expect(cancelled).toBe(true);
      expect(sent).toBeLessThan(2048);
    }
  });

  it("reports wrong answers and errors as failures", async () => {
    const routes = healthyRoutes();
    routes["https://atlas.test/auth/sign-in"] = () => html("<html>no form</html>");
    routes["https://ref.supabase.test/auth/v1/token"] = () => json({ error: "invalid_grant" }, 400);
    routes["https://gateway.test/auth/sign-in"] = () => json({});
    routes["https://atlas.test/api/v1/openapi.json"] = () => json({ openapi: "3.0.0" });
    routes["https://sync.test/probes/readiness"] = () => new Response("no", { status: 503 });
    routes["https://ref.supabase.test/functions/v1/notification-dispatch"] = () => json({}, 500);
    routes["https://api.test/v1/canon/departments"] = () => json({ data: [] });
    routes["https://docs.test/en-US"] = () => json({});
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
      ["api.host_guard", "fail", "status_200"],
      ["docs.home", "fail", "not_html"],
    ]);
    expect(failingRequired(CHECKS, results).map((r) => r.id)).not.toContain(
      "notifications.function",
    );
  });

  it("covers the remaining failure shapes", async () => {
    const routes = healthyRoutes();
    routes["https://atlas.test/auth/sign-in"] = () => html("", 503);
    routes["https://ref.supabase.test/auth/v1/token"] = () => json({ access_token: "" });
    routes["https://gateway.test/auth/sign-in"] = () => html("", 500);
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

describe("runbook links", () => {
  it("point at a section that exists, since every alert carries one", () => {
    const runbook = readFileSync(
      fileURLToPath(new URL("../../runbooks/incident-response.md", import.meta.url)),
      "utf8",
    );
    const anchors = [...runbook.matchAll(/^#{2,3} (.+)$/gm)].map((match) =>
      (match[1] ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, "")
        .replace(/ /g, "-"),
    );
    for (const definition of CHECKS) {
      expect(anchors, definition.id).toContain(definition.runbook.split("#")[1]);
    }
  });
});

describe("alert decisions", () => {
  const REQUIRED = CHECKS.filter((c) => c.id === "atlas.sign_in_page");
  const OPTIONAL = CHECKS.filter((c) => c.id === "notifications.function");
  const run = (id: string, status: CheckResult["status"], detail: string | null = null) => ({
    id,
    component: "atlas" as const,
    region: "us-east",
    status,
    latencyMs: 5,
    detail,
    at: "2026-11-06T12:00:00.000Z",
    runbook: "infra/runbooks/incident-response.md#atlas-or-gateway-unavailable",
  });
  const AT = new Date("2026-11-06T12:00:00Z");
  const REPO = "https://github.test/o/r";

  /** Folds statuses in order and returns the decision of each run. */
  function play(checks: readonly CheckDefinition[], statuses: CheckResult["status"][]) {
    let history = emptyHistory();
    return statuses.map((status) => {
      const results = [run(checks[0]?.id ?? "", status, status === "fail" ? "status_503" : null)];
      const after = recordRun(history, results, AT);
      const decision = decideAlerts(checks, results, history, after, REPO);
      history = after;
      return decision;
    });
  }

  it("stays quiet on one failed run and alerts on the second", () => {
    const [first, second] = play(REQUIRED, ["fail", "fail"]);
    expect(first).toMatchObject({ lines: [], alerted: false, changed: true });
    expect(first?.failing).toHaveLength(1);
    expect(second).toMatchObject({ alerted: true, changed: false });
    expect(second?.lines).toEqual([
      expect.stringContaining("atlas.sign_in_page (atlas) failed: status_503"),
    ]);
    expect(second?.lines[0]).toContain(`${REPO}/blob/main/infra/runbooks/incident-response.md#`);
    expect(CONFIRM_AFTER_FAILS).toBe(2);
  });

  it("does not repeat an outage on every run, and reminds at the interval", () => {
    const decisions = play(REQUIRED, Array(REMIND_EVERY_FAILS * 2).fill("fail"));
    const alerted = decisions.flatMap((d, index) => (d.alerted ? [index + 1] : []));
    expect(alerted).toEqual([CONFIRM_AFTER_FAILS, REMIND_EVERY_FAILS, REMIND_EVERY_FAILS * 2]);
  });

  it("says once that a confirmed outage ended, and nothing after a single blip", () => {
    const [, , recovered, quiet] = play(REQUIRED, ["fail", "fail", "pass", "pass"]);
    expect(recovered).toMatchObject({ alerted: false, changed: true });
    expect(recovered?.lines).toEqual([expect.stringContaining("recovered after 2 failed runs")]);
    expect(quiet).toMatchObject({ lines: [], changed: false });
    const [, blip] = play(REQUIRED, ["fail", "pass"]);
    expect(blip).toMatchObject({ lines: [], alerted: false, changed: true });
  });

  it("counts a slow answer as working, and leaves the streak alone on a skipped run", () => {
    const [, , slow] = play(REQUIRED, ["fail", "fail", "degraded"]);
    expect(slow?.lines).toEqual([expect.stringContaining("recovered")]);
    const [, skipped, third] = play(REQUIRED, ["fail", "skipped", "fail"]);
    expect(skipped).toMatchObject({ lines: [], changed: false });
    expect(third?.alerted).toBe(true);
  });

  it("never alerts for a check that is not required", () => {
    const decisions = play(OPTIONAL, ["fail", "fail", "fail"]);
    expect(decisions.every((d) => d.lines.length === 0 && !d.alerted)).toBe(true);
    expect(decisions[0]?.failing).toEqual([]);
  });

  it("reads history written before streaks existed", () => {
    const old = parseHistory(
      JSON.stringify({
        version: 1,
        updatedAt: null,
        regions: {
          "us-east": { "atlas.sign_in_page": { component: "atlas", days: {}, last: null } },
        },
      }),
    );
    const results = [run("atlas.sign_in_page", "fail", "status_503")];
    const after = recordRun(old, results, AT);
    expect(after.regions["us-east"]?.["atlas.sign_in_page"]?.failStreak).toBe(1);
    expect(decideAlerts(REQUIRED, results, old, after, REPO)).toMatchObject({
      lines: [],
      changed: true,
    });
  });

  it("posts the lines, and turns a failing webhook into a warning", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const okFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response("ok");
    }) as typeof fetch;
    expect(await postAlerts("https://hook.test/x", ["a", "b"], okFetch)).toBeNull();
    expect(calls).toEqual([{ url: "https://hook.test/x", body: '{"text":"a\\nb"}' }]);
    expect(await postAlerts("https://hook.test/x", [], okFetch)).toBeNull();
    expect(await postAlerts(undefined, ["a"], okFetch)).toBeNull();
    expect(calls).toHaveLength(1);
    const refused = (async () => new Response("no", { status: 410 })) as typeof fetch;
    expect(await postAlerts("https://hook.test/x", ["a"], refused)).toBe(
      "Alert webhook answered 410.",
    );
    const down = (async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    }) as typeof fetch;
    expect(await postAlerts("https://hook.test/x", ["a"], down)).toBe(
      "Alert webhook could not be reached: network_econnreset.",
    );
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
