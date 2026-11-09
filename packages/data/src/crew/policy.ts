import type { XosClient } from "../client.ts";
import { fail, ok, toDataError, type Result } from "../result.ts";

/**
 * The org's scheduling warnings (B9, migration 6513, ADR 0148): rest and daily and weekly maximum hours, shown before a
 * person is put on a shift and never refusing it. They are org policies, not pay or state overtime rules. Week warnings
 * use payroll.week_start, and a shift's minutes count on the day it starts.
 */

export const POLICY_WARNING_CODES = [
  "shift_rest_short",
  "shift_day_over",
  "shift_week_over",
] as const;
export type PolicyWarningCode = (typeof POLICY_WARNING_CODES)[number];

export interface PolicyWarning {
  readonly code: PolicyWarningCode;
  /** The rest gap, or the day's or week's scheduled minutes. */
  readonly minutes: number;
  readonly limitMinutes: number;
  /** The shift the gap is to, when the caller may read it. */
  readonly otherShiftId: string | null;
}

function isCode(value: string): value is PolicyWarningCode {
  return (POLICY_WARNING_CODES as readonly string[]).includes(value);
}

/**
 * Folds the rows of one person: a person can have a short gap on both sides of a shift, and the board shows one tag, so
 * the smaller gap stands for both.
 */
export function foldWarnings(rows: readonly PolicyWarning[]): PolicyWarning[] {
  const byCode = new Map<PolicyWarningCode, PolicyWarning>();
  for (const row of rows) {
    const seen = byCode.get(row.code);
    if (!seen || (row.code === "shift_rest_short" && row.minutes < seen.minutes)) {
      byCode.set(row.code, row);
    }
  }
  return POLICY_WARNING_CODES.flatMap((code) => {
    const warning = byCode.get(code);
    return warning ? [warning] : [];
  });
}

/**
 * The warnings for up to 200 people if they held a shift (app.shift_policy_warnings), by person; someone with none is
 * left out. A crew.shift.write holder asks about anyone, anyone else only about themself on a shift they can read.
 */
export async function shiftPolicyWarnings(
  db: XosClient,
  shiftId: string,
  personIds: readonly string[],
): Promise<Result<Map<string, PolicyWarning[]>>> {
  const ids = [...new Set(personIds)];
  if (ids.length === 0) return ok(new Map());
  const { data, error } = await db.rpc("shift_policy_warnings", {
    p_shift_id: shiftId,
    p_person_ids: ids,
  });
  if (error) return fail(toDataError(error));
  const byPerson = new Map<string, PolicyWarning[]>();
  for (const row of data ?? []) {
    if (!isCode(row.code)) continue;
    const list = byPerson.get(row.person_id) ?? [];
    list.push({
      code: row.code,
      minutes: row.minutes,
      limitMinutes: row.limit_minutes,
      otherShiftId: row.other_shift_id ?? null,
    });
    byPerson.set(row.person_id, list);
  }
  return ok(new Map([...byPerson].map(([id, rows]) => [id, foldWarnings(rows)])));
}
