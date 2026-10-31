import type { ProductApp } from "./product-analytics.ts";

/**
 * The workflow funnels of Sections 11.11 to 11.13 (A146, Section 11.14, ADR 0052): the registry every workflow event
 * name comes from. Each workflow's funnel is Workflow Started, Workflow Step 1 to `steps`, then Workflow Completed,
 * judged against `targetCompletion` (the share of started sessions that complete) by the hourly check of migration
 * 2340, which holds the same funnels in private.product_funnels; a unit test keeps the two equal.
 *
 * Pages emit signals, `<workflow>:start`, `<workflow>:step<n>` or `<workflow>:done`, three ways, none of which loads
 * anything until the person consented to analytics (the browser module stays unloaded otherwise):
 *   - a page view of a route template listed in `routes` (no code in the page at all);
 *   - a `data-workflow` attribute (workflowMarker in workflow-signal.ts): on a link, button or form it signals when
 *     clicked or submitted, on any other element when the element appears;
 *   - emitWorkflow (workflow-signal.ts) from client code, after a server action succeeds.
 *
 * Client-safe, but import it only where analytics already loaded (the apps' analytics-client.ts): pages import the
 * signal helpers, which carry no registry.
 */

export type OwningTeam =
  | "Projects"
  | "Work"
  | "Schedule"
  | "Show"
  | "Advancing"
  | "Crew"
  | "Finance"
  | "Procurement"
  | "Safety"
  | "Reports"
  | "Platform"
  | "Marketplace"
  | "Onboarding"
  | "Engagements"
  | "Payments"
  | "Profiles"
  | "Messaging"
  | "Field";

/** A signal's event: start, step1 to step10, or done. */
export type WorkflowSignalEvent = "start" | "done" | `step${number}`;

export interface WorkflowFunnel {
  readonly code: string;
  readonly app: ProductApp;
  readonly owningTeam: OwningTeam;
  /** Steps between the start and the completion, numbered from 1. */
  readonly steps: number;
  /** Target share of started sessions that complete, from 0 to 1. */
  readonly targetCompletion: number;
  /**
   * Route templates whose page view sends a signal, as the browser's routeTemplate gives them. A template ending in
   * `/*` matches every template below it, not itself.
   */
  readonly routes?: Readonly<Record<string, WorkflowSignalEvent>>;
}

export const WORKFLOW_FUNNELS = [
  {
    code: "atlas.projects_gates",
    app: "Atlas",
    owningTeam: "Projects",
    steps: 1,
    targetCompletion: 0.6,
    routes: { "/[org]/projects/templates": "start" },
  },
  { code: "atlas.work_records", app: "Atlas", owningTeam: "Work", steps: 1, targetCompletion: 0.5 },
  {
    code: "atlas.schedule",
    app: "Atlas",
    owningTeam: "Schedule",
    steps: 1,
    targetCompletion: 0.2,
    routes: { "/[org]/schedule/timeline": "start", "/[org]/p/[projectKey]/schedule": "start" },
  },
  { code: "atlas.show", app: "Atlas", owningTeam: "Show", steps: 1, targetCompletion: 0.7 },
  {
    code: "atlas.advancing",
    app: "Atlas",
    owningTeam: "Advancing",
    steps: 1,
    targetCompletion: 0.3,
    routes: {
      "/[org]/advancing": "start",
      "/[org]/p/[projectKey]/advancing": "start",
      "/[org]/advancing/submissions": "step1",
    },
  },
  {
    code: "atlas.crew",
    app: "Atlas",
    owningTeam: "Crew",
    steps: 1,
    targetCompletion: 0.4,
    routes: { "/[org]/crew/shifts": "start", "/[org]/p/[projectKey]/crew": "start" },
  },
  {
    code: "atlas.finance",
    app: "Atlas",
    owningTeam: "Finance",
    steps: 1,
    targetCompletion: 0.5,
    routes: { "/[org]/approvals": "start" },
  },
  {
    code: "atlas.procurement",
    app: "Atlas",
    owningTeam: "Procurement",
    steps: 1,
    targetCompletion: 0.5,
    routes: { "/[org]/procurement/rfqs": "start" },
  },
  {
    code: "atlas.safety",
    app: "Atlas",
    owningTeam: "Safety",
    steps: 1,
    targetCompletion: 0.8,
    routes: { "/[org]/safety/incidents": "start" },
  },
  {
    code: "atlas.reports",
    app: "Atlas",
    owningTeam: "Reports",
    steps: 1,
    targetCompletion: 0.25,
    routes: { "/[org]/reports": "start", "/[org]/reports/*": "step1" },
  },
  {
    code: "atlas.settings",
    app: "Atlas",
    owningTeam: "Platform",
    steps: 1,
    targetCompletion: 0.15,
  },
  {
    code: "gateway.discover",
    app: "Gateway",
    owningTeam: "Marketplace",
    steps: 1,
    targetCompletion: 0.4,
    routes: { "/home": "start", "/explore": "step1", "/explore/[opportunityKey]": "done" },
  },
  {
    code: "gateway.apply",
    app: "Gateway",
    owningTeam: "Marketplace",
    steps: 1,
    targetCompletion: 0.5,
    routes: { "/explore/[opportunityKey]": "start" },
  },
  {
    code: "gateway.onboard",
    app: "Gateway",
    owningTeam: "Onboarding",
    steps: 1,
    targetCompletion: 0.6,
  },
  {
    code: "gateway.work",
    app: "Gateway",
    owningTeam: "Engagements",
    steps: 1,
    targetCompletion: 0.5,
    routes: {
      "/home": "start",
      "/work/engagements/[engagementKey]": "step1",
      "/work/engagements/[engagementKey]/overview": "step1",
      "/work/engagements/[engagementKey]/schedule": "done",
      "/work/engagements/[engagementKey]/shifts": "done",
      "/work/engagements/[engagementKey]/run-of-show": "done",
      "/work/engagements/[engagementKey]/credentials": "done",
      "/work/engagements/[engagementKey]/travel-and-lodging": "done",
      "/work/engagements/[engagementKey]/documents": "done",
    },
  },
  {
    code: "gateway.get_paid",
    app: "Gateway",
    owningTeam: "Payments",
    steps: 1,
    targetCompletion: 0.7,
    routes: { "/money/invoices": "start", "/work/engagements/[engagementKey]/invoices": "start" },
  },
  {
    code: "gateway.reputation",
    app: "Gateway",
    owningTeam: "Profiles",
    steps: 1,
    targetCompletion: 0.3,
  },
  {
    code: "gateway.communicate",
    app: "Gateway",
    owningTeam: "Messaging",
    steps: 1,
    targetCompletion: 0.6,
    routes: {
      "/messages/[threadKey]": "start",
      "/work/engagements/[engagementKey]/messages": "start",
    },
  },
  { code: "compass.clock", app: "Compass", owningTeam: "Field", steps: 1, targetCompletion: 0.9 },
  { code: "compass.tasks", app: "Compass", owningTeam: "Field", steps: 1, targetCompletion: 0.7 },
  { code: "compass.scan", app: "Compass", owningTeam: "Field", steps: 1, targetCompletion: 0.8 },
  {
    code: "compass.incidents",
    app: "Compass",
    owningTeam: "Safety",
    steps: 1,
    targetCompletion: 0.8,
  },
  {
    code: "compass.inspections",
    app: "Compass",
    owningTeam: "Field",
    steps: 1,
    targetCompletion: 0.8,
  },
  { code: "compass.show", app: "Compass", owningTeam: "Show", steps: 1, targetCompletion: 0.7 },
  {
    code: "compass.supervisor",
    app: "Compass",
    owningTeam: "Field",
    steps: 1,
    targetCompletion: 0.7,
  },
  {
    code: "compass.credentials",
    app: "Compass",
    owningTeam: "Field",
    steps: 1,
    targetCompletion: 0.9,
  },
  // R11 (2745): typed advance answers and crew rosters in Gateway, allocations reviewed in Atlas.
  {
    code: "gateway.advance_typed_answer",
    app: "Gateway",
    owningTeam: "Advancing",
    steps: 1,
    targetCompletion: 0.6,
  },
  {
    code: "gateway.crew_roster",
    app: "Gateway",
    owningTeam: "Advancing",
    steps: 1,
    targetCompletion: 0.4,
  },
  {
    code: "atlas.advance_allocation",
    app: "Atlas",
    owningTeam: "Advancing",
    steps: 1,
    targetCompletion: 0.5,
  },
] as const satisfies readonly WorkflowFunnel[];

export type WorkflowCode = (typeof WORKFLOW_FUNNELS)[number]["code"];

/** A signal a page sends: the workflow, a colon, and start, step<n> or done. */
export type WorkflowSignal = `${WorkflowCode}:${WorkflowSignalEvent}`;

/** What a signal records, as app.record_product_events takes it. */
export interface WorkflowEventInput {
  readonly workflow: WorkflowCode;
  readonly name: "Workflow Started" | "Workflow Step" | "Workflow Completed";
  readonly step?: number;
}

const BY_CODE: ReadonlyMap<string, WorkflowFunnel> = new Map(
  WORKFLOW_FUNNELS.map((f) => [f.code, f]),
);

/** The funnel of a workflow, or undefined for a code the registry does not name. */
export function workflowFunnel(code: string): WorkflowFunnel | undefined {
  return BY_CODE.get(code);
}

/**
 * The event a signal records, or null for a signal the registry does not name: an unknown workflow, a step past the
 * funnel's last, or anything malformed. Only these names ever reach /api/product-events.
 */
export function parseWorkflowSignal(signal: unknown): WorkflowEventInput | null {
  if (typeof signal !== "string") return null;
  const match = /^([a-z]+\.[a-z_]+):(start|done|step([1-9]\d?))$/.exec(signal);
  if (!match) return null;
  const funnel = BY_CODE.get(match[1] ?? "");
  if (!funnel) return null;
  const workflow = funnel.code as WorkflowCode;
  if (match[2] === "start") return { workflow, name: "Workflow Started" };
  if (match[2] === "done") return { workflow, name: "Workflow Completed" };
  const step = Number(match[3]);
  return step <= funnel.steps ? { workflow, name: "Workflow Step", step } : null;
}

/** The signals a page view of a route template sends in an app, in registry order. */
export function routeWorkflowSignals(app: ProductApp, template: string): WorkflowSignal[] {
  const signals: WorkflowSignal[] = [];
  for (const funnel of WORKFLOW_FUNNELS as readonly WorkflowFunnel[]) {
    if (funnel.app !== app || !funnel.routes) continue;
    for (const [route, event] of Object.entries(funnel.routes)) {
      const matches = route.endsWith("/*")
        ? template.startsWith(route.slice(0, -1)) && template.length > route.length - 1
        : template === route;
      if (matches) signals.push(`${funnel.code}:${event}` as WorkflowSignal);
    }
  }
  return signals;
}

/** Every signal a funnel needs to be measured end to end: its start, each step and its completion. */
export function funnelSignals(funnel: WorkflowFunnel): WorkflowSignal[] {
  return [
    `${funnel.code}:start`,
    ...Array.from({ length: funnel.steps }, (_, i) => `${funnel.code}:step${i + 1}`),
    `${funnel.code}:done`,
  ] as WorkflowSignal[];
}
