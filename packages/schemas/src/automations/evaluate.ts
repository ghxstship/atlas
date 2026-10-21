/**
 * The automation evaluator (A91, ADR 0047): conditions over an event body, and the templates actions fill in. This
 * is the TypeScript twin of private.automation_conditions_match (migration 1480); the database evaluates when an
 * event happens, and Atlas evaluates here to test a draft against a sample event without a round trip. Both run
 * ./vectors.json. Nothing here evaluates code: a condition is a path, an operator and a text value.
 *
 * The rules, as in the SQL:
 *   - a field is a dotted path; a segment reads an object key, or an array index when it is digits. A missing path
 *     and JSON null are both missing
 *   - every operator but is_null is false on a missing value
 *   - eq: a number equals a numeric value (-?digits with an optional fraction) numerically, a boolean equals true or
 *     false, a string equals exactly; objects and arrays equal nothing. ne is not eq
 *   - lt, lte, gt and gte: numbers numerically, strings by code point; anything else is false
 *   - in: eq against any of the comma-separated values, each with spaces trimmed, empty ones skipped
 *   - contains: a string contains the value with ASCII letters folded to lower case; an array has an element that eq
 *     the value
 *   - is_null: value true (or none) holds for a missing value, false for a present one
 *   - a group holds when all (or any) of its items hold; an empty group holds
 */
import {
  trimSpaces,
  type AutomationCondition,
  type AutomationConditionItem,
  type AutomationConditions,
  type FilterOperator,
} from "./model.ts";

const NUMERIC = /^-?[0-9]+(\.[0-9]+)?$/;

/** The value at a dotted path of an event, or undefined for a missing path or JSON null. */
export function valueAt(event: unknown, field: string): unknown {
  let current: unknown = event;
  for (const segment of field.split(".")) {
    if (Array.isArray(current)) {
      if (!/^[0-9]+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (typeof current === "object" && current !== null) {
      current = Object.hasOwn(current, segment)
        ? (current as Record<string, unknown>)[segment]
        : undefined;
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current === null ? undefined : current;
}

function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Compares two strings by code point, as collation C does on UTF-8. */
export function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function equals(actual: unknown, value: string): boolean {
  if (typeof actual === "string") return actual === value;
  if (typeof actual === "boolean")
    return (value === "true" && actual) || (value === "false" && !actual);
  if (typeof actual === "number") return NUMERIC.test(value) && actual === Number(value);
  return false;
}

/** One condition against the value found in the event. */
export function compare(
  actual: unknown,
  operator: FilterOperator,
  value: string | null | undefined,
): boolean {
  if (operator === "is_null") {
    const wantsMissing = value === null || value === undefined || value === "true";
    return wantsMissing ? actual === undefined : actual !== undefined;
  }
  if (actual === undefined || actual === null) return false;
  const text = value ?? "";
  switch (operator) {
    case "eq":
      return equals(actual, text);
    case "ne":
      return !equals(actual, text);
    case "in":
      return text
        .split(",")
        .map(trimSpaces)
        .some((item) => item !== "" && equals(actual, item));
    case "contains":
      if (typeof actual === "string") return foldAscii(actual).includes(foldAscii(text));
      if (Array.isArray(actual)) return actual.some((element) => equals(element, text));
      return false;
    default: {
      let order: number;
      if (typeof actual === "number" && NUMERIC.test(text)) order = actual - Number(text);
      else if (typeof actual === "string") order = compareCodePoints(actual, text);
      else return false;
      if (operator === "lt") return order < 0;
      if (operator === "lte") return order <= 0;
      if (operator === "gt") return order > 0;
      return order >= 0;
    }
  }
}

function isGroup(
  entry: AutomationConditionItem,
): entry is { all: AutomationCondition[] } | { any: AutomationCondition[] } {
  return "all" in entry || "any" in entry;
}

function itemsMatch(
  match: "all" | "any",
  items: readonly AutomationConditionItem[],
  event: unknown,
): boolean {
  if (items.length === 0) return true;
  for (const entry of items) {
    const held = isGroup(entry)
      ? "all" in entry
        ? itemsMatch("all", entry.all, event)
        : itemsMatch("any", entry.any, event)
      : compare(valueAt(event, entry.field), entry.operator, entry.value);
    if (match === "all" && !held) return false;
    if (match === "any" && held) return true;
  }
  return match === "all";
}

/** Whether a conditions document holds for an event body. */
export function conditionsMatch(conditions: AutomationConditions, event: unknown): boolean {
  return "all" in conditions
    ? itemsMatch("all", conditions.all, event)
    : itemsMatch("any", conditions.any, event);
}

export interface ConditionResult {
  readonly field: string;
  readonly operator: FilterOperator;
  readonly value: string | null;
  /** The value found in the event, or null when missing. */
  readonly actual: unknown;
  readonly matched: boolean;
}

/** A dry run: whether the conditions hold and, per condition in document order, the value found and the outcome. */
export function explainConditions(
  conditions: AutomationConditions,
  event: unknown,
): { readonly matched: boolean; readonly conditions: readonly ConditionResult[] } {
  const items = "all" in conditions ? conditions.all : conditions.any;
  const results: ConditionResult[] = [];
  const add = (c: AutomationCondition) => {
    const actual = valueAt(event, c.field);
    results.push({
      field: c.field,
      operator: c.operator,
      value: c.value ?? null,
      actual: actual ?? null,
      matched: compare(actual, c.operator, c.value),
    });
  };
  for (const entry of items) {
    if (isGroup(entry)) ("all" in entry ? entry.all : entry.any).forEach(add);
    else add(entry);
  }
  return { matched: conditionsMatch(conditions, event), conditions: results };
}

/** The `{{ path }}` insertions of a template. */
export const TEMPLATE_PATH = /\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z0-9_]+){0,7})\s*\}\}/g;

function display(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Fills a template's `{{ path }}` insertions from the event: text as it is, numbers and booleans as written,
 * objects and arrays as JSON, missing values as nothing. Anything else in braces stays as typed.
 */
export function renderTemplate(template: string, event: unknown): string {
  return template.replace(TEMPLATE_PATH, (_whole, path: string) => display(valueAt(event, path)));
}

/** A rendered template trimmed of spaces and cut to `limit` code points, as the action's API field allows. */
export function renderField(template: string, event: unknown, limit: number): string {
  const text = trimSpaces(renderTemplate(template, event));
  const chars = Array.from(text);
  return chars.length <= limit ? text : trimSpaces(chars.slice(0, limit).join(""));
}
