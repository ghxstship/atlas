import type { XosClient } from "./client.ts";
import type { Result } from "./result.ts";
import { list, num, rpc, str, strOrNull, type Raw } from "./platform-common.ts";

/**
 * Platform metrics for the operator console (A137, migration 2300; Section 4.10, ADR 0046). One document of
 * platform-wide aggregates read from XOS's own database through app.console_platform_metrics, which checks the
 * operator, the tenants.read permission and the second factor first (private.require_platform_operator). Counts and
 * sums only: the document names no org, person or record.
 */

export interface MetricsWeek {
  /** Monday of the week, in UTC (YYYY-MM-DD). */
  readonly weekStart: string;
  readonly newOrgs: number;
  readonly signUps: number;
  readonly auroraRequests: number;
}

export interface PlanMix {
  readonly planCode: string;
  /** Orgs with a live subscription on the plan, in any state. */
  readonly orgs: number;
  readonly trialing: number;
  readonly active: number;
  readonly pastDue: number;
  readonly readOnly: number;
}

export interface UsageTotal {
  /** First day of the closed month (YYYY-MM-DD). */
  readonly periodStart: string;
  readonly meterCode: string;
  readonly unit: string;
  readonly quantity: number;
  readonly orgs: number;
}

export interface JobKindHealth {
  readonly jobKind: string;
  /** Queued and due now. */
  readonly ready: number;
  /** Queued for later: a retry backing off or a job set to run after a time. */
  readonly scheduled: number;
  readonly running: number;
  /** Running for more than 30 minutes. */
  readonly stalled: number;
  readonly failed24h: number;
  readonly succeeded24h: number;
  readonly oldestReadyAt: string | null;
}

export interface ChannelDeliveries {
  readonly channel: string;
  readonly total: number;
  readonly sent: number;
  readonly pending: number;
  readonly failed: number;
  readonly bounced: number;
  readonly suppressed: number;
}

export interface PlatformMetrics {
  readonly generatedAt: string;
  readonly weeks: readonly MetricsWeek[];
  readonly orgs: {
    readonly live: number;
    readonly clients: number;
    readonly withoutSubscription: number;
  };
  readonly people: {
    readonly withAccount: number;
    readonly active1d: number;
    readonly active7d: number;
    readonly active30d: number;
  };
  readonly plans: readonly PlanMix[];
  readonly trials: { readonly trialing: number; readonly ending7d: number };
  readonly usage: readonly UsageTotal[];
  readonly aurora: {
    readonly requests30d: number;
    readonly outcomes: readonly { readonly outcome: string; readonly requests: number }[];
    readonly features: readonly { readonly feature: string; readonly requests: number }[];
    readonly inputTokens30d: number;
    readonly outputTokens30d: number;
  };
  readonly jobs: readonly JobKindHealth[];
  readonly notifications: readonly ChannelDeliveries[];
}

const obj = (v: unknown): Raw =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : {};

/** Parses app.console_platform_metrics's document; a missing group reads as empty or zero. */
export function parsePlatformMetrics(data: unknown): PlatformMetrics {
  const d = obj(data);
  const orgs = obj(d["orgs"]);
  const people = obj(d["people"]);
  const trials = obj(d["trials"]);
  const aurora = obj(d["aurora"]);
  return {
    generatedAt: str(d["generated_at"]),
    weeks: list(d["weeks"]).map((w) => ({
      weekStart: str(w["week_start"]),
      newOrgs: num(w["new_orgs"]),
      signUps: num(w["sign_ups"]),
      auroraRequests: num(w["aurora_requests"]),
    })),
    orgs: {
      live: num(orgs["live"]),
      clients: num(orgs["clients"]),
      withoutSubscription: num(orgs["without_subscription"]),
    },
    people: {
      withAccount: num(people["with_account"]),
      active1d: num(people["active_1d"]),
      active7d: num(people["active_7d"]),
      active30d: num(people["active_30d"]),
    },
    plans: list(d["plans"]).map((p) => ({
      planCode: str(p["plan_code"]),
      orgs: num(p["orgs"]),
      trialing: num(p["trialing"]),
      active: num(p["active"]),
      pastDue: num(p["past_due"]),
      readOnly: num(p["read_only"]),
    })),
    trials: { trialing: num(trials["trialing"]), ending7d: num(trials["ending_7d"]) },
    usage: list(d["usage"]).map((u) => ({
      periodStart: str(u["period_start"]),
      meterCode: str(u["meter_code"]),
      unit: str(u["unit"]),
      quantity: num(u["quantity"]),
      orgs: num(u["orgs"]),
    })),
    aurora: {
      requests30d: num(aurora["requests_30d"]),
      outcomes: list(aurora["outcomes"]).map((o) => ({
        outcome: str(o["outcome"]),
        requests: num(o["requests"]),
      })),
      features: list(aurora["features"]).map((f) => ({
        feature: str(f["feature"]),
        requests: num(f["requests"]),
      })),
      inputTokens30d: num(aurora["input_tokens_30d"]),
      outputTokens30d: num(aurora["output_tokens_30d"]),
    },
    jobs: list(d["jobs"]).map((j) => ({
      jobKind: str(j["job_kind"]),
      ready: num(j["ready"]),
      scheduled: num(j["scheduled"]),
      running: num(j["running"]),
      stalled: num(j["stalled"]),
      failed24h: num(j["failed_24h"]),
      succeeded24h: num(j["succeeded_24h"]),
      oldestReadyAt: strOrNull(j["oldest_ready_at"]),
    })),
    notifications: list(d["notifications"]).map((n) => ({
      channel: str(n["channel"]),
      total: num(n["total"]),
      sent: num(n["sent"]),
      pending: num(n["pending"]),
      failed: num(n["failed"]),
      bounced: num(n["bounced"]),
      suppressed: num(n["suppressed"]),
    })),
  };
}

/** Platform-wide figures for the last `weeks` weeks (1 to 52, 12 by default; the database clamps it too). */
export async function getPlatformMetrics(
  db: XosClient,
  input: { readonly weeks?: number } = {},
): Promise<Result<PlatformMetrics>> {
  const weeks = Math.min(Math.max(Math.trunc(input.weeks ?? 12), 1), 52);
  return rpc(db, "console_platform_metrics", { p_weeks: weeks }, parsePlatformMetrics);
}

/** The share of a channel's settled deliveries that failed or bounced, 0 to 1, or null when none settled. */
export function failureRate(c: ChannelDeliveries): number | null {
  const settled = c.sent + c.failed + c.bounced;
  return settled === 0 ? null : (c.failed + c.bounced) / settled;
}
