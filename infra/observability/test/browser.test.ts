import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_FRAMES,
  installClientReporter,
  reportClientError,
  routeTemplate,
  scrubText,
  setReporterUser,
  trimStack,
  type ClientErrorPayload,
} from "../src/browser.ts";

/** The value, or a thrown error naming what was missing. */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a value");
  return value;
}

const ATLAS_ROUTES = [
  "/auth/invite/[token]",
  "/auth",
  "/legal/[document]",
  "/partner/[partnerSlug]",
  "/[org]/p/[projectKey]",
  "/[org]/r/[recordKey]",
  "/[org]",
];

/** A window stand-in: an EventTarget with a location. */
function fakeWindow(pathname: string) {
  const target = new EventTarget();
  return Object.assign(target, {
    location: { origin: "https://atlas.example", pathname, search: "?email=ada@example.com" },
  });
}

function errorEvent(init: { error?: unknown; message?: string; filename?: string }): Event {
  return Object.assign(new Event("error"), init);
}

function rejection(reason: unknown): Event {
  return Object.assign(new Event("unhandledrejection"), { reason });
}

describe("routeTemplate", () => {
  it("replaces dynamic segments with the template and drops the query", () => {
    expect(routeTemplate("/acme/p/NWS/work?tab=2", ATLAS_ROUTES)).toBe(
      "/[org]/p/[projectKey]/work",
    );
    expect(routeTemplate("/acme/crew/shifts", ATLAS_ROUTES)).toBe("/[org]/crew/shifts");
    expect(routeTemplate("/auth/invite/abc123secret", ATLAS_ROUTES)).toBe("/auth/invite/[token]");
    expect(routeTemplate("/auth/sign-in", ATLAS_ROUTES)).toBe("/auth/sign-in");
  });

  it("turns unmatched segments that hold a digit into [id]", () => {
    expect(
      routeTemplate("/acme/work/tasks/4f1c2e7a-0000-4000-8000-000000000001", ATLAS_ROUTES),
    ).toBe("/[org]/work/tasks/[id]");
    expect(routeTemplate("/", ATLAS_ROUTES)).toBe("/");
  });
});

describe("scrubText and trimStack", () => {
  it("removes query strings, fragments, credentials, emails and long tokens", () => {
    const out = scrubText(
      "GET https://x.example/a?token=abc&email=ada@example.com#access_token=zzz failed for ada@example.com " +
        "Bearer abc.def eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig " +
        "k".repeat(40),
    );
    expect(out).not.toContain("token=abc");
    expect(out).not.toContain("access_token");
    expect(out).not.toContain("ada@example.com");
    expect(out).not.toContain("abc.def");
    expect(out).not.toContain("eyJ");
    expect(out).not.toContain("kkkk");
    expect(out).toContain("https://x.example/a");
  });

  it("keeps only frame lines, without query strings, and keeps line and column", () => {
    const stack = [
      "TypeError: boom for ada@example.com",
      "    at render (https://atlas.example/_next/static/chunks/app.js?dpl=abc:1:2345)",
      "fetchData@https://atlas.example/_next/static/chunks/page.js?v=1:10:20",
      "not a frame",
    ].join("\n");
    expect(trimStack(stack)).toBe(
      [
        "at render (https://atlas.example/_next/static/chunks/app.js:1:2345)",
        "fetchData@https://atlas.example/_next/static/chunks/page.js:10:20",
      ].join("\n"),
    );
    expect(trimStack(undefined)).toBeUndefined();
    expect(trimStack("no frames here")).toBeUndefined();
    const long = Array.from(
      { length: 40 },
      (_, i) => `    at f${i} (https://a.example/x.js:1:${i})`,
    );
    expect(trimStack(long.join("\n"))?.split("\n")).toHaveLength(MAX_FRAMES);
  });
});

describe("installClientReporter", () => {
  let sent: ClientErrorPayload[];
  let uninstall: () => void;
  let win: ReturnType<typeof fakeWindow>;

  beforeEach(() => {
    sent = [];
    win = fakeWindow("/acme/p/NWS/work");
    vi.stubGlobal("window", win);
    uninstall = installClientReporter({
      endpoint: "/api/client-errors",
      routes: ATLAS_ROUTES,
      release: "abc123",
      send: (endpoint, body) => {
        expect(endpoint).toBe("/api/client-errors");
        sent.push(JSON.parse(body) as ClientErrorPayload);
      },
    });
  });

  afterEach(() => {
    uninstall();
    vi.unstubAllGlobals();
  });

  it("sends a minimal, redacted payload for a window error", () => {
    const error = new TypeError("Cannot read user ada@example.com at /acme?token=secret");
    error.stack = `TypeError: x\n    at f (https://atlas.example/_next/static/chunks/a.js?dpl=1:1:2)`;
    win.dispatchEvent(
      errorEvent({ error, filename: "https://atlas.example/_next/static/chunks/a.js" }),
    );
    expect(sent).toEqual([
      {
        message: "TypeError: Cannot read user [email] at /acme",
        stack: "at f (https://atlas.example/_next/static/chunks/a.js:1:2)",
        route: "/[org]/p/[projectKey]/work",
        source: "window",
        release: "abc123",
      },
    ]);
    const body = JSON.stringify(sent);
    expect(body).not.toContain("token");
    expect(body).not.toContain("?");
    expect(body).not.toContain("acme/p/NWS");
  });

  it("reports unhandled rejections and attaches the user id once known", () => {
    setReporterUser("4f1c2e7a-0000-4000-8000-000000000001");
    win.dispatchEvent(rejection(new Error("save failed with 555-123-4567")));
    win.dispatchEvent(rejection("plain string reason"));
    win.dispatchEvent(rejection({ not: "an error" }));
    expect(sent.map((p) => [p.source, p.message, p.userId])).toEqual([
      ["promise", "Error: save failed with [number]", "4f1c2e7a-0000-4000-8000-000000000001"],
      ["promise", "plain string reason", "4f1c2e7a-0000-4000-8000-000000000001"],
      ["promise", "Non-error value thrown", "4f1c2e7a-0000-4000-8000-000000000001"],
    ]);
  });

  it("ignores errors from other origins and opaque script errors", () => {
    win.dispatchEvent(
      errorEvent({ error: new Error("ext"), filename: "chrome-extension://abc/content.js" }),
    );
    win.dispatchEvent(errorEvent({ message: "Script error." }));
    win.dispatchEvent(errorEvent({}));
    expect(sent).toHaveLength(0);
    win.dispatchEvent(errorEvent({ message: "ResizeObserver loop limit exceeded" }));
    expect(sent.map((p) => p.message)).toEqual(["ResizeObserver loop limit exceeded"]);
  });

  it("throttles: duplicates are sent once and at most five reports leave per page", () => {
    for (let i = 0; i < 3; i += 1) reportClientError(new Error("same"));
    expect(sent).toHaveLength(1);
    for (let i = 0; i < 10; i += 1)
      reportClientError(new Error(`distinct ${String.fromCharCode(97 + i)}`));
    expect(sent).toHaveLength(5);
  });

  it("skips boundary errors that carry a server digest", () => {
    const error = Object.assign(new Error("server render"), { digest: "123" });
    expect(reportClientError(error)).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("does nothing once uninstalled, and installing twice keeps one reporter", () => {
    const again = installClientReporter({ endpoint: "/other", routes: [] });
    expect(again).toBe(uninstall);
    uninstall();
    win.dispatchEvent(rejection(new Error("after")));
    expect(reportClientError(new Error("direct"))).toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});

describe("default delivery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts with navigator.sendBeacon as JSON", async () => {
    const beacon = vi.fn<(url: string, body: Blob) => boolean>(() => true);
    vi.stubGlobal("window", fakeWindow("/acme/home"));
    vi.stubGlobal("navigator", { sendBeacon: beacon });
    const uninstall = installClientReporter({ endpoint: "/api/client-errors", routes: ["/[org]"] });
    reportClientError(new Error("boom"));
    uninstall();
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = must(beacon.mock.calls[0]);
    expect(url).toBe("/api/client-errors");
    expect(blob.type).toBe("application/json");
    expect(JSON.parse(await blob.text())).toMatchObject({
      route: "/[org]/home",
      source: "boundary",
    });
  });

  it("is inert without a window", () => {
    vi.stubGlobal("window", undefined);
    const uninstall = installClientReporter({ endpoint: "/x", routes: [] });
    expect(reportClientError(new Error("x"))).toBeUndefined();
    uninstall();
  });
});
