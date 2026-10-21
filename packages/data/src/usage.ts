import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * An org's metered usage for Settings, Usage (A86, RRR-131, finding A65-004; Section 4.5.6 org settings item 38,
 * Section 16): the open billing month so far and the closed monthly totals, per meter with its unit (migration
 * 1433 over 0510's usage events and rollups). Billing months are UTC, as the rollup and Stripe count them.
 * Needs org.usage.read.
 */

export interface UsageLine {
  readonly meter: string;
  readonly unit: string;
  readonly quantity: number;
}

export interface UsagePeriod {
  /** First day of the billing month, YYYY-MM-DD. */
  readonly periodStart: string;
  /** False for the open month, whose numbers still grow. */
  readonly closed: boolean;
  readonly lines: readonly UsageLine[];
}

/** The open month first, then closed months newest first. */
export async function getOrgUsage(
  db: XosClient,
  orgId: string,
  months = 3,
): Promise<Result<UsagePeriod[]>> {
  const { data, error } = await db.rpc("org_usage", { p_org_id: orgId, p_months: months });
  if (error) return fail(toDataError(error));
  const periods = new Map<string, { closed: boolean; lines: UsageLine[] }>();
  for (const row of data ?? []) {
    const key = `${row.period_start}|${row.closed}`;
    const period = periods.get(key) ?? { closed: row.closed, lines: [] };
    period.lines.push({ meter: row.meter_code, unit: row.unit, quantity: Number(row.quantity) });
    periods.set(key, period);
  }
  return ok(
    [...periods.entries()]
      .map(([key, p]) => ({
        periodStart: key.split("|")[0] ?? "",
        closed: p.closed,
        lines: p.lines,
      }))
      .sort(
        (a, b) => Number(a.closed) - Number(b.closed) || b.periodStart.localeCompare(a.periodStart),
      ),
  );
}
