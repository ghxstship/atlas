/**
 * Runs the synthetic checks, turns them into results, alerts and a rolling daily history that the
 * status page renders.
 */

import type {
  CheckContext,
  CheckDefinition,
  CheckResult,
  CheckStatus,
  ComponentId,
  WebSocketLike,
} from "./types.ts";

export interface RunOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly region: string;
  readonly fetch?: typeof fetch;
  readonly openWebSocket?: (url: string) => WebSocketLike;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

function defaultWebSocket(url: string): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Ctor)
    throw new Error("This runtime has no WebSocket; run the checks on Node 22.4 or later.");
  return new Ctor(url);
}

/** Runs each check in order. A check never throws out of this function; errors become a fail. */
export async function runChecks(
  checks: readonly CheckDefinition[],
  options: RunOptions,
): Promise<CheckResult[]> {
  const now = options.now ?? (() => Date.now());
  const context: CheckContext = {
    env: options.env,
    fetch: options.fetch ?? fetch,
    openWebSocket: options.openWebSocket ?? defaultWebSocket,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    shared: new Map(),
  };
  const results: CheckResult[] = [];
  for (const check of checks) {
    const started = now();
    const at = new Date(started).toISOString();
    const common = {
      id: check.id,
      component: check.component,
      region: options.region,
      at,
      runbook: check.runbook,
    };
    const missing = check.requires.filter((name) => !options.env[name]);
    if (missing.length > 0) {
      results.push({
        ...common,
        status: "skipped",
        latencyMs: null,
        detail: `missing_${missing.join("_")}`,
      });
      continue;
    }
    let status: CheckStatus;
    let detail: string | null;
    try {
      const outcome = await check.probe(context);
      if (outcome.ok) {
        const latency = now() - started;
        status = latency > check.budgetMs ? "degraded" : "pass";
        detail = status === "degraded" ? `over_budget_${check.budgetMs}ms` : null;
      } else {
        status = "fail";
        detail = outcome.detail;
      }
    } catch (error) {
      status = "fail";
      detail = errorDetail(error);
    }
    results.push({ ...common, status, latencyMs: Math.round(now() - started), detail });
  }
  return results;
}

/** A short machine-readable reason for a thrown error, without its message (which may echo input). */
export function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timeout";
    const cause = (error as { cause?: { code?: unknown } }).cause;
    if (cause && typeof cause.code === "string") return `network_${cause.code.toLowerCase()}`;
    return `error_${error.name.toLowerCase()}`;
  }
  return "error_unknown";
}

/** Required checks that failed in this run: these page on-call. */
export function failingRequired(
  checks: readonly CheckDefinition[],
  results: readonly CheckResult[],
): CheckResult[] {
  const required = new Set(checks.filter((c) => c.required).map((c) => c.id));
  return results.filter((r) => r.status === "fail" && required.has(r.id));
}

/** One alert line per failing check, each with its runbook link (Section 5.1: runbooks in every alert). */
export function formatAlerts(results: readonly CheckResult[], repositoryUrl: string): string[] {
  return results
    .filter((r) => r.status === "fail")
    .map(
      (r) =>
        `[${r.region}] ${r.id} (${r.component}) failed: ${r.detail ?? "unknown"} after ${r.latencyMs ?? 0} ms. Runbook: ${repositoryUrl}/blob/main/${r.runbook}`,
    );
}

/** A required check alerts on its second failure in a row, so one lost request wakes no one. */
export const CONFIRM_AFTER_FAILS = 2;
/** Then it reminds at this interval, about every six hours at one run every five minutes. */
export const REMIND_EVERY_FAILS = 72;

export interface AlertDecision {
  /** Lines to post now: the failures just confirmed or due a reminder, and the recoveries. */
  readonly lines: readonly string[];
  /** True when a failure line is among them: this run reports an alert and is marked failed. */
  readonly alerted: boolean;
  /** Required checks that are failing, confirmed or not. */
  readonly failing: readonly CheckResult[];
  /** True when a check started or stopped failing, so the status page has something new to say. */
  readonly changed: boolean;
}

/**
 * Decides what a run says, from the history before it and after it. An outage posts once when it is
 * confirmed, again at each reminder and once when it ends, not on every run. A check that is not
 * required shows on the status page and never alerts.
 */
export function decideAlerts(
  checks: readonly CheckDefinition[],
  results: readonly CheckResult[],
  before: StatusHistory,
  after: StatusHistory,
  repositoryUrl: string,
): AlertDecision {
  const required = new Set(checks.filter((c) => c.required).map((c) => c.id));
  const failure: CheckResult[] = [];
  const recovered: string[] = [];
  let changed = false;
  for (const result of results) {
    if (result.status === "skipped") continue;
    const previous = before.regions[result.region]?.[result.id];
    const streak = after.regions[result.region]?.[result.id]?.failStreak ?? 0;
    const previousStreak = previous?.failStreak ?? 0;
    if (previous === undefined || (streak === 0) !== (previousStreak === 0)) changed = true;
    if (!required.has(result.id)) continue;
    const due =
      streak === CONFIRM_AFTER_FAILS ||
      (streak > CONFIRM_AFTER_FAILS && streak % REMIND_EVERY_FAILS === 0);
    if (due) failure.push(result);
    if (streak === 0 && previousStreak >= CONFIRM_AFTER_FAILS) {
      recovered.push(
        `[${result.region}] ${result.id} (${result.component}) recovered after ${previousStreak} failed runs.`,
      );
    }
  }
  return {
    lines: [...formatAlerts(failure, repositoryUrl), ...recovered],
    alerted: failure.length > 0,
    failing: failingRequired(checks, results),
    changed,
  };
}

/** Posts alert lines to the on-call webhook. A webhook that fails is a warning for the run, never a crash. */
export async function postAlerts(
  webhook: string | undefined,
  lines: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  if (!webhook || lines.length === 0) return null;
  try {
    const response = await fetcher(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: lines.join("\n") }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? null : `Alert webhook answered ${response.status}.`;
  } catch (error) {
    return `Alert webhook could not be reached: ${errorDetail(error)}.`;
  }
}

// History ---------------------------------------------------------------------------------------------

export interface DayCounts {
  pass: number;
  degraded: number;
  fail: number;
}

export interface CheckHistory {
  readonly component: ComponentId;
  /** Daily counts keyed by UTC date (YYYY-MM-DD). */
  days: Record<string, DayCounts>;
  /** The latest non-skipped result, or the latest result when every run was skipped. */
  last: CheckResult | null;
  /** Failed runs in a row; absent on history written before alerts were confirmed. */
  failStreak?: number;
}

export interface StatusHistory {
  version: 1;
  updatedAt: string | null;
  /** Keyed by region, then by check id. */
  regions: Record<string, Record<string, CheckHistory>>;
}

export const HISTORY_DAYS = 90;

export function emptyHistory(): StatusHistory {
  return { version: 1, updatedAt: null, regions: {} };
}

/** Folds one run into the history and drops days older than the retention window. */
export function recordRun(
  history: StatusHistory,
  results: readonly CheckResult[],
  at: Date,
): StatusHistory {
  const next: StatusHistory = structuredClone(history);
  next.updatedAt = at.toISOString();
  for (const result of results) {
    const region = (next.regions[result.region] ??= {});
    const entry = (region[result.id] ??= { component: result.component, days: {}, last: null });
    if (result.status === "skipped") {
      if (!entry.last || entry.last.status === "skipped") entry.last = result;
      continue;
    }
    const day = result.at.slice(0, 10);
    const counts = (entry.days[day] ??= { pass: 0, degraded: 0, fail: 0 });
    counts[result.status] += 1;
    entry.last = result;
    entry.failStreak = result.status === "fail" ? (entry.failStreak ?? 0) + 1 : 0;
  }
  const cutoff = new Date(at.getTime() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const region of Object.values(next.regions)) {
    for (const entry of Object.values(region)) {
      entry.days = Object.fromEntries(Object.entries(entry.days).filter(([day]) => day >= cutoff));
    }
  }
  return next;
}

export function parseHistory(text: string | null): StatusHistory {
  if (!text) return emptyHistory();
  const parsed = JSON.parse(text) as Partial<StatusHistory>;
  if (parsed.version !== 1 || typeof parsed.regions !== "object" || parsed.regions === null) {
    throw new Error("Status history file is not version 1; refusing to overwrite it.");
  }
  return { version: 1, updatedAt: parsed.updatedAt ?? null, regions: parsed.regions };
}
