import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  funnelSignals,
  parseWorkflowSignal,
  routeWorkflowSignals,
  WORKFLOW_FUNNELS,
  workflowFunnel,
  type WorkflowFunnel,
} from "../src/product-workflows.ts";
import { acknowledgeFunnelAlert, getConsoleFunnels } from "../src/console-funnels.ts";
import { moduleClient } from "./module-client.ts";
import { emitWorkflow, WORKFLOW_SIGNAL_EVENT, workflowMarker } from "../src/workflow-signal.ts";

/**
 * The workflow funnels of Sections 11.11 to 11.13 (A146, migration 2340, ADR 0052): the registry the browser reads,
 * held to the funnels the hourly check judges, and every Atlas and Gateway funnel measured end to end by a signal in
 * the apps' code or a route.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signals", () => {
  it("names only the registry's workflows and steps", () => {
    expect(parseWorkflowSignal("atlas.finance:start")).toEqual({
      workflow: "atlas.finance",
      name: "Workflow Started",
    });
    expect(parseWorkflowSignal("gateway.apply:step1")).toEqual({
      workflow: "gateway.apply",
      name: "Workflow Step",
      step: 1,
    });
    expect(parseWorkflowSignal("atlas.show:done")).toEqual({
      workflow: "atlas.show",
      name: "Workflow Completed",
    });
    for (const bad of [
      "atlas.finance:step2",
      "atlas.finance:step0",
      "atlas.anything:start",
      "atlas.finance:finished",
      "atlas.finance",
      "/acme/approvals",
      42,
      null,
      { workflow: "atlas.finance" },
    ]) {
      expect(parseWorkflowSignal(bad)).toBeNull();
    }
  });

  it("maps route templates to the signals of the app's funnels", () => {
    expect(routeWorkflowSignals("Atlas", "/[org]/approvals")).toEqual(["atlas.finance:start"]);
    expect(routeWorkflowSignals("Atlas", "/[org]/reports")).toEqual(["atlas.reports:start"]);
    expect(routeWorkflowSignals("Atlas", "/[org]/reports/labor")).toEqual(["atlas.reports:step1"]);
    expect(routeWorkflowSignals("Gateway", "/home")).toEqual([
      "gateway.discover:start",
      "gateway.work:start",
    ]);
    expect(routeWorkflowSignals("Gateway", "/explore/[opportunityKey]")).toEqual([
      "gateway.discover:done",
      "gateway.apply:start",
    ]);
    expect(routeWorkflowSignals("Gateway", "/[org]/approvals")).toEqual([]);
    expect(routeWorkflowSignals("Atlas", "/home")).toEqual([]);
  });

  it("lists every signal a funnel needs", () => {
    expect(funnelSignals(workflowFunnel("atlas.crew") as WorkflowFunnel)).toEqual([
      "atlas.crew:start",
      "atlas.crew:step1",
      "atlas.crew:done",
    ]);
    expect(workflowFunnel("atlas.nothing")).toBeUndefined();
  });

  it("dispatches a window event and marks markup", () => {
    const dispatched: Event[] = [];
    vi.stubGlobal("dispatchEvent", (e: Event) => dispatched.push(e));
    emitWorkflow("atlas.finance:step1");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.type).toBe(WORKFLOW_SIGNAL_EVENT);
    expect((dispatched[0] as CustomEvent).detail).toBe("atlas.finance:step1");
    expect(workflowMarker("gateway.apply:done")).toEqual({ "data-workflow": "gateway.apply:done" });
  });
});

describe("the registry follows the migrations", () => {
  const funnels = new Map(
    [
      ...read("supabase/migrations/2340_workflow_funnels.sql").matchAll(
        /\('((?:atlas|gateway|compass)\.[a-z_]+)', '([A-Za-z]+)', (\d+), ([\d.]+)\)/g,
      ),
    ].map((m) => [m[1] ?? "", { team: m[2], steps: Number(m[3]), target: Number(m[4]) }]),
  );
  const workflows = [
    ...read("supabase/migrations/1532_product_analytics.sql").matchAll(
      /\('((?:atlas|gateway|compass)\.[a-z_]+)', '(Atlas|Gateway|Compass)'/g,
    ),
  ].map((m) => [m[1] ?? "", m[2] ?? ""]);

  it("names every workflow of 1532 with its app, and no other", () => {
    expect(workflows).toHaveLength(26);
    expect(WORKFLOW_FUNNELS.map((f) => [f.code, f.app])).toEqual(workflows);
  });

  it("holds each funnel's team, steps and target as private.product_funnels does", () => {
    expect(funnels.size).toBe(26);
    for (const f of WORKFLOW_FUNNELS) {
      expect(funnels.get(f.code), f.code).toEqual({
        team: f.owningTeam,
        steps: f.steps,
        target: f.targetCompletion,
      });
    }
  });
});

describe("every Atlas and Gateway funnel is measured end to end", () => {
  const sources = (dir: string): string[] =>
    readdirSync(join(root, dir)).flatMap((name) => {
      const path = join(dir, name);
      if (["node_modules", ".next", "e2e", "test"].includes(name)) return [];
      if (statSync(join(root, path)).isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(name) ? [read(path)] : [];
    });
  const code = [...sources("apps/atlas"), ...sources("apps/gateway")].join("\n");
  const literals = new Set(
    [
      ...code.matchAll(/["'`]((?:atlas|gateway|compass)\.[a-z_]+:(?:start|done|step\d+))["'`]/g),
    ].map((m) => m[1] ?? ""),
  );
  const routed = new Set(
    (WORKFLOW_FUNNELS as readonly WorkflowFunnel[]).flatMap((f) =>
      Object.values(f.routes ?? {}).map((event) => `${f.code}:${event}`),
    ),
  );

  it("names only signals the registry knows", () => {
    for (const signal of literals) expect(parseWorkflowSignal(signal), signal).not.toBeNull();
  });

  it("sends a start, each step and a completion for every web workflow", () => {
    const web = (WORKFLOW_FUNNELS as readonly WorkflowFunnel[]).filter((f) => f.app !== "Compass");
    expect(web).toHaveLength(18);
    const missing = web
      .flatMap((f) => funnelSignals(f))
      .filter((s) => !literals.has(s) && !routed.has(s));
    expect(missing).toEqual([]);
  });

  // ADR 0001: a form bound to a server action posts without JavaScript only while useActionState holds the server
  // action itself, so a form signals success from its result (useActionOutcome or a success effect), never by wrapping
  // the action.
  it("keeps the server action in useActionState where a form signals success", () => {
    const forms: readonly (readonly [string, string])[] = [
      ["apps/gateway/components/explore/forms.tsx", "applyAction"],
      ["apps/gateway/components/engagement/forms.tsx", "submitInvoiceAction"],
      ["apps/gateway/components/engagement/forms.tsx", "uploadOnboardingAction"],
      ["apps/gateway/components/engagement/forms.tsx", "sendMessageAction"],
      ["apps/atlas/components/advancing/forms.tsx", "reviewSubmissionAction"],
      ["apps/atlas/components/crew/forms-drawer-form.tsx", "props.action"],
      ["apps/atlas/components/collection-kit/kit.tsx", "action"],
    ];
    for (const [path, action] of forms) {
      const held = [...read(path).matchAll(/useActionState(?:<[^>]*>)?\(\s*([\w.]+)/g)].map(
        (m) => m[1],
      );
      expect(held, `${path} ${action}`).toContain(action);
    }
    expect(code).not.toMatch(/signalOnSuccess/);
  });
});

describe("funnels in the operator console", () => {
  it("reads every funnel with its stages and the alerts, and acknowledges one", async () => {
    const { db } = moduleClient({
      "rpc:console_product_funnels": [
        {
          data: {
            checkedAt: "2026-10-28T10:00:00Z",
            funnels: [
              {
                workflow: "atlas.crew",
                app: "Atlas",
                owningTeam: "Crew",
                stepCount: 1,
                targetCompletion: 0.4,
                stages: [40, 30, 12],
                startedSessions: 40,
                completedSessions: 12,
                completionRate: 0.3,
                baselineRate: 0.6,
                status: "Regressed",
              },
              { workflow: "compass.scan", status: "Something new", stages: null },
            ],
            alerts: [
              {
                id: "a1",
                workflow: "atlas.crew",
                owningTeam: "Crew",
                raisedAt: "2026-10-28T09:23:00Z",
                lastCheckedAt: "2026-10-28T09:23:00Z",
                startedSessions: 40,
                completedSessions: 12,
                completionRate: 0.3,
                baselineRate: null,
                targetCompletion: 0.4,
                belowTarget: true,
                belowBaseline: false,
                acknowledgedAt: null,
                acknowledgedByName: null,
                resolvedAt: null,
              },
            ],
          },
          error: null,
        },
        {
          data: null,
          error: { code: "42501", message: "the operator console is for the platform team" },
        },
      ],
      "rpc:console_acknowledge_funnel_alert": [{ data: "a1", error: null }],
    });
    const read = await getConsoleFunnels(db);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.data.funnels[0]).toMatchObject({ stages: [40, 30, 12], status: "Regressed" });
    expect(read.data.funnels[1]).toMatchObject({ stages: [], status: "Not Enough Data" });
    expect(read.data.alerts[0]).toMatchObject({ belowTarget: true, baselineRate: null });
    expect((await getConsoleFunnels(db)).ok).toBe(false);
    expect(await acknowledgeFunnelAlert(db, "a1")).toEqual({ ok: true, data: "a1" });
  });
});
