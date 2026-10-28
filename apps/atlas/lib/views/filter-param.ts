/**
 * How a filter condition is spelled as a query parameter (A117; conditions.ts has the grammar): the field, then
 * the operator after a dot unless it is eq. Kept apart from conditions.ts so the saved view round trip
 * (query.ts), which every collection loads, carries only this much (A24-009).
 */

export const CONDITION_OPERATORS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "is_null",
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export function isConditionOperator(value: unknown): value is ConditionOperator {
  return typeof value === "string" && (CONDITION_OPERATORS as readonly string[]).includes(value);
}

/** True for a query parameter the Add filter control writes: a `f.` or `cf.` condition. */
export function isConditionParam(name: string): boolean {
  return name.startsWith("f.") || name.startsWith("cf.");
}

/**
 * A saved view filter's field and operator from a query parameter name: `cf.seats.gte` is field `cf.seats` with
 * gte, and any other name is itself with eq.
 */
export function splitFilterParam(name: string): { field: string; operator: ConditionOperator } {
  const parts = name.split(".");
  const last = parts[parts.length - 1] ?? "";
  if (parts.length === 3 && (parts[0] === "f" || parts[0] === "cf") && isConditionOperator(last)) {
    return { field: `${parts[0]}.${parts[1]}`, operator: last };
  }
  return { field: name, operator: "eq" };
}

/** The query parameter name of a field and operator; the inverse of `splitFilterParam`. */
export function filterParam(field: string, operator: ConditionOperator): string {
  return operator === "eq" ? field : `${field}.${operator}`;
}
