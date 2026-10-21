import { afterEach, describe, expect, it, vi } from "vitest";
import { globalPrivacyControl, productAnalytics } from "../src/pwa/analytics.ts";

/** The browser side of consent-gated product analytics (A96): route templates in small batches, nothing under GPC. */

const template = (path: string) => path.replace(/^\/[^/]+/, "/[org]");
const now = () => new Date("2026-10-21T10:00:00.000Z");

afterEach(() => {
  Reflect.deleteProperty(navigator, "globalPrivacyControl");
  vi.useRealTimers();
});

describe("product analytics in the browser", () => {
  it("sends route templates and workflow steps in one batch per session key", () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const analytics = productAnalytics({
      endpoint: "/api/product-events",
      template,
      send: (b) => sent.push(b),
      now,
    });
    analytics.pageViewed("/northwind/projects");
    analytics.workflow("atlas.projects_gates", "Workflow Step", 2);
    analytics.workflow("atlas.projects_gates", "Workflow Completed");
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(5000);
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0] ?? "{}") as { sessionKey: string; events: unknown[] };
    expect(body.sessionKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.events).toEqual([
      { occurredAt: "2026-10-21T10:00:00.000Z", name: "Page Viewed", route: "/[org]/projects" },
      {
        occurredAt: "2026-10-21T10:00:00.000Z",
        name: "Workflow Step",
        workflow: "atlas.projects_gates",
        step: 2,
      },
      {
        occurredAt: "2026-10-21T10:00:00.000Z",
        name: "Workflow Completed",
        workflow: "atlas.projects_gates",
      },
    ]);
    analytics.flush();
    expect(sent).toHaveLength(1);
  });

  it("flushes a full batch at once and when the page hides", () => {
    const sent: string[] = [];
    const analytics = productAnalytics({
      endpoint: "/api/product-events",
      template,
      send: (b) => sent.push(b),
      now,
    });
    for (let i = 0; i < 10; i += 1) analytics.pageViewed(`/northwind/p/${i}`);
    expect(sent).toHaveLength(1);
    analytics.pageViewed("/northwind/home");
    window.dispatchEvent(new Event("pagehide"));
    expect(sent).toHaveLength(2);
  });

  it("does nothing at all when the browser sends Global Privacy Control", () => {
    Object.defineProperty(navigator, "globalPrivacyControl", { value: true, configurable: true });
    expect(globalPrivacyControl()).toBe(true);
    const send = vi.fn();
    const analytics = productAnalytics({ endpoint: "/api/product-events", template, send });
    analytics.pageViewed("/northwind/home");
    analytics.workflow("atlas.reports", "Workflow Started");
    analytics.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("posts to its own origin with keepalive by default", () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const analytics = productAnalytics({ endpoint: "/api/product-events", template, now });
    analytics.pageViewed("/northwind/home");
    analytics.flush();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/product-events",
      expect.objectContaining({ method: "POST", keepalive: true }),
    );
    vi.unstubAllGlobals();
  });
});
