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

/**
 * Workflow funnel signals (A146): a registry passed in by the app turns page views, data-workflow markers and window
 * events into Workflow Started, Step and Completed events; nothing else, and nothing under Global Privacy Control.
 */
describe("workflow signals", () => {
  const parse = (value: unknown) => {
    const m =
      typeof value === "string" ? /^(atlas\.finance):(start|done|step(1))$/.exec(value) : null;
    if (!m) return null;
    if (m[2] === "start") return { workflow: m[1] ?? "", name: "Workflow Started" as const };
    if (m[2] === "done") return { workflow: m[1] ?? "", name: "Workflow Completed" as const };
    return { workflow: m[1] ?? "", name: "Workflow Step" as const, step: 1 };
  };
  const workflows = {
    eventName: "xos:workflow",
    parse,
    forRoute: (route: string) => (route === "/[org]/approvals" ? ["atlas.finance:start"] : []),
  };
  const events = (sent: string[]) =>
    sent.flatMap((b) => (JSON.parse(b) as { events: { name: string; step?: number }[] }).events);
  const flushMutations = () => new Promise((resolve) => setTimeout(resolve, 0));

  const running: { stop(): void }[] = [];
  const start = (options: Parameters<typeof productAnalytics>[0]) => {
    const analytics = productAnalytics(options);
    running.push(analytics);
    return analytics;
  };

  afterEach(() => {
    for (const analytics of running.splice(0)) analytics.stop();
    document.body.innerHTML = "";
    window.sessionStorage.clear();
  });

  it("starts from a page view, steps on a click and completes when a marker appears", async () => {
    const sent: string[] = [];
    const analytics = start({
      endpoint: "/api/product-events",
      template,
      send: (b) => sent.push(b),
      now,
      workflows,
    });
    // Already on the page before any start: dropped, and never counted again.
    document.body.innerHTML = '<span hidden data-workflow="atlas.finance:done"></span>';
    await flushMutations();
    analytics.pageViewed("/northwind/approvals");
    const button = document.createElement("button");
    button.setAttribute("data-workflow", "atlas.finance:step1");
    document.body.append(button);
    button.click();
    const done = document.createElement("span");
    done.setAttribute("data-workflow", "atlas.finance:done");
    document.body.append(done);
    await flushMutations();
    analytics.flush();
    expect(events(sent).map((e) => e.name)).toEqual([
      "Page Viewed",
      "Workflow Started",
      "Workflow Step",
      "Workflow Completed",
    ]);
  });

  it("counts a step or completion only after the session started the workflow", () => {
    const sent: string[] = [];
    const analytics = start({
      endpoint: "/e",
      template,
      send: (b) => sent.push(b),
      now,
      workflows,
    });
    window.dispatchEvent(new CustomEvent("xos:workflow", { detail: "atlas.finance:done" }));
    window.dispatchEvent(new CustomEvent("xos:workflow", { detail: "atlas.finance:start" }));
    window.dispatchEvent(new CustomEvent("xos:workflow", { detail: "atlas.finance:done" }));
    analytics.flush();
    expect(events(sent).map((e) => e.name)).toEqual(["Workflow Started", "Workflow Completed"]);
    expect(window.sessionStorage.getItem("xos-analytics-started")).toBe('["atlas.finance"]');
  });

  it("signals a submitted form and drops what the registry does not name", async () => {
    const sent: string[] = [];
    const analytics = start({
      endpoint: "/e",
      template,
      send: (b) => sent.push(b),
      now,
      workflows,
    });
    window.dispatchEvent(new CustomEvent("xos:workflow", { detail: "atlas.finance:start" }));
    const form = document.createElement("form");
    form.setAttribute("data-workflow", "atlas.finance:step1");
    form.addEventListener("submit", (e) => e.preventDefault());
    document.body.append(form);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    window.dispatchEvent(new CustomEvent("xos:workflow", { detail: "atlas.anything:start" }));
    window.dispatchEvent(new CustomEvent("xos:workflow", { detail: { record: "NWS-1" } }));
    const outside = document.createElement("div");
    outside.setAttribute("data-workflow", "atlas.finance:step1");
    outside.innerHTML = "<p>not a control</p>";
    document.body.append(outside);
    await flushMutations();
    outside.querySelector("p")?.click();
    analytics.flush();
    expect(events(sent)).toEqual([
      {
        occurredAt: "2026-10-21T10:00:00.000Z",
        name: "Workflow Started",
        workflow: "atlas.finance",
      },
      {
        occurredAt: "2026-10-21T10:00:00.000Z",
        name: "Workflow Step",
        workflow: "atlas.finance",
        step: 1,
      },
      // The div appeared (a marker that is not a control signals once, when it appears); the click on it adds none.
      {
        occurredAt: "2026-10-21T10:00:00.000Z",
        name: "Workflow Step",
        workflow: "atlas.finance",
        step: 1,
      },
    ]);
  });

  it("records no workflow event under Global Privacy Control", () => {
    Object.defineProperty(navigator, "globalPrivacyControl", { value: true, configurable: true });
    const send = vi.fn();
    const analytics = start({ endpoint: "/e", template, send, now, workflows });
    analytics.pageViewed("/northwind/approvals");
    window.dispatchEvent(new CustomEvent("xos:workflow", { detail: "atlas.finance:start" }));
    analytics.flush();
    expect(send).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("xos-analytics-started")).toBeNull();
  });
});
