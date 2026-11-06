import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  emptyHistory,
  recordRun,
  type CheckResult,
  type StatusHistory,
} from "../../synthetics/src/index.ts";
import {
  currentState,
  dailyStates,
  escapeHtml,
  format,
  lightThemeAsMediaQuery,
  renderStatusPage,
  uptime,
  type Incident,
  type StatusConfig,
  type StatusMessages,
} from "../src/render.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const messages = (locale: string) =>
  JSON.parse(
    readFileSync(`${repo}packages/i18n/messages/${locale}/status.json`, "utf8"),
  ) as StatusMessages;
const config = JSON.parse(
  readFileSync(`${repo}infra/status/status.config.json`, "utf8"),
) as StatusConfig;

const NOW = new Date("2026-10-16T12:00:00Z");
const tokenCss = {
  base: ":root{--space-2:2px}",
  dark: ':root, [data-theme="dark"]{--color-bg-canvas:black}',
  light: '[data-theme="light"]{--color-bg-canvas:white}',
};

function result(
  id: string,
  component: CheckResult["component"],
  status: CheckResult["status"],
  at: string,
): CheckResult {
  return {
    id,
    component,
    region: "us-east",
    status,
    latencyMs: 10,
    detail: null,
    at,
    runbook: "r",
  };
}

function history(results: CheckResult[]): StatusHistory {
  return recordRun(emptyHistory(), results, NOW);
}

describe("state rules", () => {
  it("derives current state from the freshest result of each check", () => {
    const h = history([
      result("atlas.sign_in_page", "atlas", "pass", "2026-10-16T11:55:00Z"),
      result("atlas.sign_in", "atlas", "degraded", "2026-10-16T11:55:00Z"),
      result("api.read", "api", "fail", "2026-10-16T11:55:00Z"),
      result("sync.liveness", "sync", "pass", "2026-10-16T10:00:00Z"),
      result("notifications.function", "notifications", "skipped", "2026-10-16T11:55:00Z"),
      result("gateway.home", "gateway", "pass", "2026-10-16T11:59:00Z"),
    ]);
    expect(currentState(h, "us-east", "atlas", NOW, 20)).toBe("degraded");
    expect(currentState(h, "us-east", "api", NOW, 20)).toBe("outage");
    expect(currentState(h, "us-east", "sync", NOW, 20)).toBe("unknown");
    expect(currentState(h, "us-east", "notifications", NOW, 20)).toBe("unknown");
    expect(currentState(h, "us-east", "gateway", NOW, 20)).toBe("operational");
    expect(currentState(h, "eu-central", "atlas", NOW, 20)).toBe("unknown");
  });

  it("summarizes days and uptime", () => {
    const runs: CheckResult[] = [];
    for (let i = 0; i < 99; i += 1)
      runs.push(result("api.read", "api", "pass", "2026-10-15T01:00:00Z"));
    runs.push(result("api.read", "api", "fail", "2026-10-15T02:00:00Z"));
    runs.push(result("api.read", "api", "fail", "2026-10-14T02:00:00Z"));
    runs.push(result("api.read", "api", "pass", "2026-10-16T02:00:00Z"));
    runs.push(result("api.read", "api", "degraded", "2026-10-13T02:00:00Z"));
    const h = history(runs);
    expect(dailyStates(h, "us-east", "api", NOW, 5)).toEqual([
      { day: "2026-10-12", state: "unknown" },
      { day: "2026-10-13", state: "degraded" },
      { day: "2026-10-14", state: "outage" },
      { day: "2026-10-15", state: "degraded" },
      { day: "2026-10-16", state: "operational" },
    ]);
    expect(uptime(h, "us-east", "api", NOW, 30)).toBeCloseTo(101 / 103);
    expect(uptime(h, "us-east", "realtime", NOW, 30)).toBeNull();
  });

  it("marks a day slow by its share of slow answers, not by one of them", () => {
    const day = (slow: number) => {
      const runs: CheckResult[] = [];
      for (let i = 0; i < 100 - slow; i += 1) {
        runs.push(result("api.openapi", "api", "pass", "2026-10-16T01:00:00Z"));
      }
      for (let i = 0; i < slow; i += 1) {
        runs.push(result("api.openapi", "api", "degraded", "2026-10-16T02:00:00Z"));
      }
      return dailyStates(history(runs), "us-east", "api", NOW, 1)[0]?.state;
    };
    expect(day(0)).toBe("operational");
    expect(day(1)).toBe("operational");
    expect(day(5)).toBe("operational");
    expect(day(6)).toBe("degraded");
  });
});

describe("helpers", () => {
  it("formats, escapes and moves the light theme into a media query", () => {
    expect(format("{a} and {b} and {c}", { a: 1, b: "x" })).toBe("1 and x and {c}");
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
    expect(lightThemeAsMediaQuery('[data-theme="light"]{--x:1}')).toBe(
      "@media (prefers-color-scheme: light){:root{--x:1}}",
    );
  });
});

describe("renderStatusPage", () => {
  const rowOf = (html: string, name: string) =>
    html.split('<li class="component">').find((row) => row.includes(`"name">${name}<`)) ?? "";

  it("claims a check only for a component a check touched", () => {
    const at = "2026-10-16T11:55:00Z";
    const html = renderStatusPage({
      locale: "en-US",
      messages: messages("en-US"),
      config,
      history: history([
        result("atlas.sign_in_page", "atlas", "pass", at),
        result("atlas.sign_in", "atlas", "skipped", at),
        result("realtime.join", "realtime", "skipped", at),
        result("sync.liveness", "sync", "skipped", at),
        result("notifications.function", "notifications", "skipped", at),
      ]),
      incidents: [],
      now: NOW,
      tokenCss,
    });
    expect(rowOf(html, "Atlas")).toContain("Last checked");
    expect(rowOf(html, "Atlas")).toContain("Operational");
    for (const name of ["Realtime", "Compass sync", "Notifications"]) {
      expect(rowOf(html, name)).toContain("No data");
      expect(rowOf(html, name)).toContain("Not checked yet");
      expect(rowOf(html, name)).not.toContain("Last checked");
    }
    expect(html).toContain('data-state="operational">The components we check are operational.');
  });

  it("does not name a component in its lede, in either locale", () => {
    for (const locale of ["en-US", "es-US"]) {
      const { description } = messages(locale);
      expect(description).not.toMatch(/Atlas|Gateway|API|Realtime|Compass|notific/i);
    }
  });

  it("renders the empty state before any check has reported", () => {
    const html = renderStatusPage({
      locale: "en-US",
      messages: messages("en-US"),
      config,
      history: emptyHistory(),
      incidents: [],
      now: NOW,
      tokenCss,
    });
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain('data-state="unknown">Status checks have not reported yet.');
    expect(html).toContain("No checks recorded in the last 30 days");
    expect(html).toContain("Not checked yet");
    expect(html).toContain("No incidents in the last 14 days.");
    expect(html).toContain("@media (prefers-color-scheme: light){:root{--color-bg-canvas:white}}");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("http-equiv");
    expect((html.match(/class="component"/g) ?? []).length).toBe(
      config.components.length * config.regions.length,
    );
  });

  it("renders states, uptime, history labels and incidents in Spanish", () => {
    const h = history([
      result("api.read", "api", "fail", "2026-10-16T11:58:00Z"),
      result("atlas.sign_in_page", "atlas", "pass", "2026-10-16T11:58:00Z"),
    ]);
    const incidents: Incident[] = [
      {
        id: "inc-1",
        components: ["api"],
        regions: ["us-east"],
        startedAt: "2026-10-16T11:30:00Z",
        resolvedAt: null,
        text: {
          "en-US": { title: "API errors", update: "Investigating." },
          "es-US": { title: "Errores de la API", update: "En investigación." },
        },
      },
      {
        id: "inc-0",
        components: ["atlas"],
        regions: ["us-east"],
        startedAt: "2026-10-10T08:00:00Z",
        resolvedAt: "2026-10-10T09:00:00Z",
        text: { "en-US": { title: "Slow pages <b>", update: "Fixed." } },
      },
      {
        id: "inc-old",
        components: ["atlas"],
        regions: ["us-east"],
        startedAt: "2026-08-01T08:00:00Z",
        resolvedAt: "2026-08-01T09:00:00Z",
        text: {},
      },
      {
        id: "inc-untitled",
        components: ["sync"],
        regions: ["us-east"],
        startedAt: "2026-10-15T08:00:00Z",
        resolvedAt: "2026-10-15T09:00:00Z",
        text: {},
      },
    ];
    const html = renderStatusPage({
      locale: "es-US",
      messages: messages("es-US"),
      config: { ...config, regions: ["us-east", "ap-south"] },
      history: h,
      incidents,
      now: NOW,
      tokenCss,
    });
    expect(html).toContain('data-state="outage">Algunos sistemas no están disponibles.');
    expect(html).toContain("Interrupción");
    expect(html).toMatch(/>0\.00\s?% de disponibilidad/);
    expect(html).toContain("Historial diario de API en Este de EE. UU.");
    expect(html).toContain("Errores de la API");
    expect(html).toContain("En curso");
    expect(html).toContain("Slow pages &lt;b&gt;");
    expect(html).toContain("inc-untitled");
    expect(html).not.toContain("inc-old");
    expect(html).toContain('id="region-ap-south">ap-south');
    expect(html.indexOf("Errores de la API")).toBeLessThan(html.indexOf("inc-untitled"));
  });

  it("does not claim all systems while a component has no data", () => {
    const h = history([result("gateway.home", "gateway", "pass", "2026-10-16T11:58:00Z")]);
    const html = renderStatusPage({
      locale: "en-US",
      messages: messages("en-US"),
      config,
      history: h,
      incidents: [],
      now: NOW,
      tokenCss,
    });
    expect(html).not.toContain("All systems operational");
    expect(html).toContain('data-state="operational">The components we check are operational.');
    expect(html).toContain("100.00% uptime over the last 30 days");
  });

  it("shows all systems operational when every component passes", () => {
    const h = history(
      config.components.map((component) =>
        result(`${component}.check`, component, "pass", "2026-10-16T11:58:00Z"),
      ),
    );
    const html = renderStatusPage({
      locale: "es-US",
      messages: messages("es-US"),
      config,
      history: h,
      incidents: [],
      now: NOW,
      tokenCss,
    });
    expect(html).toContain('data-state="operational">Todos los sistemas funcionan con normalidad');
    expect(html).toContain("Documentación");
  });
});
