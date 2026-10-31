import type { XosClient } from "./client.ts";
import { bool, num, numOrNull, rpc, str, strOrNull, type Raw } from "./platform-common.ts";
import type { Result } from "./result.ts";

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Raw =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : {};

/**
 * The workflow funnels in the operator console (A146, migration 2340, ADR 0052): each Sections 11.11 to 11.13
 * workflow's funnel over the last 24 hours against its target and the 7 days before, and the regression alerts the
 * hourly check raised for the owning team. Counts only, never a person, an org or a path. Every operator role reads
 * them (tenants.read) and may acknowledge an alert, which the console ledger records.
 */

export type FunnelStatus = "On Target" | "Below Target" | "Regressed" | "Not Enough Data";

const STATUSES: readonly FunnelStatus[] = [
  "On Target",
  "Below Target",
  "Regressed",
  "Not Enough Data",
];

export interface ConsoleFunnel {
  readonly workflow: string;
  readonly app: string;
  readonly owningTeam: string;
  readonly stepCount: number;
  readonly targetCompletion: number;
  /** Sessions per stage: started, each step, completed. */
  readonly stages: readonly number[];
  readonly startedSessions: number;
  readonly completedSessions: number;
  readonly completionRate: number | null;
  readonly baselineRate: number | null;
  readonly status: FunnelStatus;
}

export interface FunnelAlert {
  readonly id: string;
  readonly workflow: string;
  readonly owningTeam: string;
  readonly raisedAt: string;
  readonly lastCheckedAt: string;
  readonly startedSessions: number;
  readonly completedSessions: number;
  readonly completionRate: number;
  readonly baselineRate: number | null;
  readonly targetCompletion: number;
  readonly belowTarget: boolean;
  readonly belowBaseline: boolean;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedByName: string | null;
  readonly resolvedAt: string | null;
}

export interface ConsoleFunnels {
  readonly checkedAt: string;
  readonly funnels: readonly ConsoleFunnel[];
  /** Open alerts first, then those resolved in the last 30 days, newest first. */
  readonly alerts: readonly FunnelAlert[];
}

function status(value: unknown): FunnelStatus {
  return STATUSES.find((s) => s === value) ?? "Not Enough Data";
}

export function parseConsoleFunnels(data: unknown): ConsoleFunnels {
  const d = obj(data);
  return {
    checkedAt: str(d["checkedAt"]),
    funnels: arr(d["funnels"]).map((raw) => {
      const f = obj(raw);
      return {
        workflow: str(f["workflow"]),
        app: str(f["app"]),
        owningTeam: str(f["owningTeam"]),
        stepCount: num(f["stepCount"]),
        targetCompletion: num(f["targetCompletion"]),
        stages: arr(f["stages"]).map(num),
        startedSessions: num(f["startedSessions"]),
        completedSessions: num(f["completedSessions"]),
        completionRate: numOrNull(f["completionRate"]),
        baselineRate: numOrNull(f["baselineRate"]),
        status: status(f["status"]),
      };
    }),
    alerts: arr(d["alerts"]).map((raw) => {
      const a = obj(raw);
      return {
        id: str(a["id"]),
        workflow: str(a["workflow"]),
        owningTeam: str(a["owningTeam"]),
        raisedAt: str(a["raisedAt"]),
        lastCheckedAt: str(a["lastCheckedAt"]),
        startedSessions: num(a["startedSessions"]),
        completedSessions: num(a["completedSessions"]),
        completionRate: num(a["completionRate"]),
        baselineRate: numOrNull(a["baselineRate"]),
        targetCompletion: num(a["targetCompletion"]),
        belowTarget: bool(a["belowTarget"]),
        belowBaseline: bool(a["belowBaseline"]),
        acknowledgedAt: strOrNull(a["acknowledgedAt"]),
        acknowledgedByName: strOrNull(a["acknowledgedByName"]),
        resolvedAt: strOrNull(a["resolvedAt"]),
      };
    }),
  };
}

/** The funnels and their alerts (app.console_product_funnels). */
export async function getConsoleFunnels(db: XosClient): Promise<Result<ConsoleFunnels>> {
  return rpc(db, "console_product_funnels", {}, parseConsoleFunnels);
}

/** Marks an open alert seen by the signed-in operator (app.console_acknowledge_funnel_alert). */
export async function acknowledgeFunnelAlert(
  db: XosClient,
  alertId: string,
): Promise<Result<string>> {
  return rpc(db, "console_acknowledge_funnel_alert", { p_alert_id: alertId }, str);
}
