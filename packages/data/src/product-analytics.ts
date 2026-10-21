import type { XosClient } from "./client.ts";
import type { Json } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Consent-gated, first-party product analytics (Section 11.14, A65-022, migration 1532, ADR 0052). No outside
 * provider: that would be a new subprocessor and needs an owner decision. Nothing is recorded unless the person
 * consented to performance cookies and their browser sends no Global Privacy Control signal; by default nothing is.
 *
 * Client-safe: the apps' event route and their browser code share these shapes.
 */

export type ProductApp = "Atlas" | "Gateway" | "Compass";
export const PRODUCT_EVENT_NAMES = [
  "Page Viewed",
  "Workflow Started",
  "Workflow Step",
  "Workflow Completed",
] as const;
export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];

/** One event. No person, org, path or free text: a route template, a workflow and a step at most. */
export interface ProductEvent {
  readonly occurredAt: string;
  readonly name: ProductEventName;
  /** Route template with every slug, key, id and token replaced by its parameter name. */
  readonly route?: string;
  /** Workflow of Sections 11.11 to 11.13, app.name, for example atlas.projects_gates. */
  readonly workflow?: string;
  readonly step?: number;
}

/** What the consent seam reads: the person's performance choice, if any, and the browser's GPC signal. */
export interface ConsentSignals {
  /** True only when the person said yes to performance (analytics) cookies; null when they never chose. */
  readonly performance: boolean | null;
  /** The browser sends Global Privacy Control (Sec-GPC: 1). */
  readonly gpc: boolean;
}

/**
 * The consent seam: analytics only with a recorded yes to performance cookies and no Global Privacy Control. Every
 * other case, no choice included, means no analytics. A82's cookie banner feeds `performance` in each app's
 * lib/privacy/product-analytics.ts, the one place it is read.
 */
export function productAnalyticsAllowed(signals: ConsentSignals): boolean {
  return signals.performance === true && !signals.gpc;
}

/** True when the request carries the Global Privacy Control header. */
export function sendsGlobalPrivacyControl(headers: { get(name: string): string | null }): boolean {
  return headers.get("sec-gpc")?.trim() === "1";
}

const ROUTE = /^\/[A-Za-z0-9/_.[\]-]*$/;
const WORKFLOW = /^(atlas|gateway|compass)\.[a-z][a-z_]*$/;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Keeps the well-formed events of a batch, at most 25, and drops anything else. */
export function cleanProductEvents(input: unknown): ProductEvent[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 25).flatMap((raw): ProductEvent[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const e = raw as Record<string, unknown>;
    const name = PRODUCT_EVENT_NAMES.find((n) => n === e["name"]);
    const occurredAt =
      typeof e["occurredAt"] === "string" && !Number.isNaN(Date.parse(e["occurredAt"]))
        ? e["occurredAt"]
        : null;
    if (!name || occurredAt === null) return [];
    if (name === "Page Viewed") {
      const route = e["route"];
      return typeof route === "string" && route.length <= 200 && ROUTE.test(route)
        ? [{ occurredAt, name, route }]
        : [];
    }
    const workflow = e["workflow"];
    if (typeof workflow !== "string" || !WORKFLOW.test(workflow)) return [];
    const step = e["step"];
    if (name === "Workflow Step")
      return typeof step === "number" && Number.isInteger(step) && step >= 0 && step <= 50
        ? [{ occurredAt, name, workflow, step }]
        : [];
    return [{ occurredAt, name, workflow }];
  });
}

/** True for a session key the browser made (a random UUID). */
export function isSessionKey(value: unknown): value is string {
  return typeof value === "string" && SESSION.test(value);
}

/** Records a consented batch. Call only after productAnalyticsAllowed said yes. */
export async function recordProductEvents(
  db: XosClient,
  input: {
    readonly app: ProductApp;
    readonly sessionKey: string;
    readonly events: readonly ProductEvent[];
  },
): Promise<Result<number>> {
  if (input.events.length === 0) return ok(0);
  const { data, error } = await db.rpc("record_product_events", {
    p_app_code: input.app,
    p_session_key: input.sessionKey,
    p_events: input.events as unknown as Json,
  });
  if (error) return fail(toDataError(error));
  return ok(typeof data === "number" ? data : 0);
}
