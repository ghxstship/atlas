/**
 * Filter conditions in a collection's query string (A117, Section 11.15), which the Add filter control writes
 * and saved views keep. Two namespaces keep them apart from a page's own filter parameters:
 *
 *   f.<field>    a field the page declares (a column), matched on what the page shows;
 *   cf.<key>     an org custom field (Settings, Custom fields), which the page's loader applies through
 *                custom_field_values.
 *
 * The operator follows the field after a dot, and plain means eq: `cf.seats.gte=100` is Seats at least 100,
 * `f.vendor.contains=acme` is Vendor contains acme, `cf.tier=gold` is Tier is Gold. Operators are the API's
 * (app.filter_operator, ADR 0003), so a saved view stores field `cf.seats`, operator `gte`, value `100`.
 */

import { filterParam, splitFilterParam, type ConditionOperator } from "./query";

export {
  CONDITION_OPERATORS,
  filterParam,
  isConditionOperator,
  splitFilterParam,
  type ConditionOperator,
} from "./query";

export type ConditionScope = "field" | "custom";

export interface Condition {
  readonly scope: ConditionScope;
  /** Field key: a column key in snake case, or a custom field key. */
  readonly key: string;
  readonly operator: ConditionOperator;
  readonly value: string;
}

const PREFIX: Readonly<Record<ConditionScope, string>> = { field: "f.", custom: "cf." };
const KEY = /^[a-z][a-z0-9_]{0,47}$/;
const MAX_VALUE = 1000;

/** A column key as the URL spells it: `dueOn` is `due_on`. */
export function fieldParamKey(columnKey: string): string {
  return columnKey.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/[^a-z0-9_]/g, "_");
}

/** One query parameter as a condition, or null when it is not one. */
export function parseCondition(name: string, value: string): Condition | null {
  const scope: ConditionScope | null = name.startsWith(PREFIX.custom)
    ? "custom"
    : name.startsWith(PREFIX.field)
      ? "field"
      : null;
  if (scope === null || value === "" || value.length > MAX_VALUE) return null;
  const { field, operator } = splitFilterParam(name);
  const key = field.slice(PREFIX[scope].length);
  return KEY.test(key) ? { scope, key, operator, value } : null;
}

/** The query parameter a condition is written as. */
export function conditionParam(condition: Condition): [name: string, value: string] {
  return [
    filterParam(`${PREFIX[condition.scope]}${condition.key}`, condition.operator),
    condition.value,
  ];
}

type SearchLike =
  URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>;

function entriesOf(search: SearchLike): [string, string][] {
  if (search instanceof URLSearchParams) return [...search.entries()];
  return Object.entries(search).flatMap(([name, value]) => {
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === "string" ? [[name, first] as [string, string]] : [];
  });
}

/** Every condition in a query string, in order, one per parameter name. */
export function conditionsOf(search: SearchLike): Condition[] {
  const seen = new Set<string>();
  const out: Condition[] = [];
  for (const [name, value] of entriesOf(search)) {
    if (seen.has(name)) continue;
    const condition = parseCondition(name, value);
    if (!condition) continue;
    seen.add(name);
    out.push(condition);
  }
  return out;
}

/** The custom field conditions of a query string, as a loader hands them to `matchCustomFieldConditions`. */
export function customConditionsOf(
  search: SearchLike,
): { key: string; operator: ConditionOperator; value: string }[] {
  return conditionsOf(search)
    .filter((c) => c.scope === "custom")
    .map(({ key, operator, value }) => ({ key, operator, value }));
}

/**
 * Whether a shown value passes a declared-field condition. Matching is on the text the page shows, ignoring
 * case: is and is not compare the whole text, contains a part of it, and is empty checks for no text.
 */
export function matchesShown(shown: string, condition: Condition): boolean {
  const text = shown.trim().toLowerCase();
  const wanted = condition.value.trim().toLowerCase();
  switch (condition.operator) {
    case "eq":
      return text === wanted;
    case "ne":
      return text !== wanted;
    case "contains":
      return text.includes(wanted);
    case "is_null":
      return (text === "") === (wanted !== "false");
    default: {
      const a = Number(text.replace(/[^0-9.-]/g, ""));
      const b = Number(wanted.replace(/[^0-9.-]/g, ""));
      if (text === "" || Number.isNaN(a) || Number.isNaN(b)) return false;
      if (condition.operator === "gt") return a > b;
      if (condition.operator === "gte") return a >= b;
      if (condition.operator === "lt") return a < b;
      return a <= b;
    }
  }
}

/** The operators a declared field offers: it is matched on its shown text. */
export const FIELD_OPERATORS: readonly ConditionOperator[] = ["contains", "eq", "ne", "is_null"];
