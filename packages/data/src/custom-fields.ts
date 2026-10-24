import { addCalendarDays, instantOfLocalIn, startOfDayIn } from "./calendar.ts";
import type { XosClient } from "./client.ts";
import type { CustomDataType, CustomField } from "./governance.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Custom field values on built-in tables (A117, RRR-162; Section 4.5.6 org settings item 16, 0540). An org
 * defines fields per table in Settings (governance.ts); this module reads the definitions of one table, reads
 * and writes the values of its rows in the typed column of each field's data type (value_text, value_number,
 * value_money_minor with value_currency, value_date, value_timestamp, value_boolean, value_choice_id,
 * value_person_id), and finds the rows whose values match view filters. Writes are table writes under row level
 * security, the same path as the customFieldValues operations of the API: a Collaborator or higher writes the
 * values of a row they can read, and the 0540 guard with its 1760 required check refuses the rest.
 *
 * Forms send values as the text an input holds (`CustomFieldInput`); `checkCustomFieldInputs` turns that text
 * into typed values and says which fields are missing or malformed, so the browser and the server apply the same
 * rules before anything is written.
 */

export type { CustomDataType, CustomField, CustomFieldChoice } from "./governance.ts";

/** The built-in tables orgs may add custom fields to (private.custom_field_targets, 0540). */
export const CUSTOM_FIELD_TABLES = [
  "app.records",
  "app.projects",
  "app.vendors",
  "app.venues",
  "app.counterparties",
  "app.asset_units",
  "app.purchase_orders",
  "app.invoices",
  "app.incidents",
] as const;

export type CustomFieldTable = (typeof CUSTOM_FIELD_TABLES)[number];

export function isCustomFieldTable(value: unknown): value is CustomFieldTable {
  return typeof value === "string" && (CUSTOM_FIELD_TABLES as readonly string[]).includes(value);
}

/** A stored value, by data type. */
export type CustomFieldValue =
  | { readonly type: "Text" | "Email" | "URL"; readonly text: string }
  | { readonly type: "Number"; readonly number: number }
  | { readonly type: "Money"; readonly minor: number; readonly currency: string }
  | { readonly type: "Date"; readonly date: string }
  | { readonly type: "Timestamp"; readonly at: string }
  | { readonly type: "Boolean"; readonly boolean: boolean }
  | { readonly type: "Choice"; readonly choiceId: string }
  | { readonly type: "Person"; readonly personId: string };

/**
 * A field's value as a form holds it: the input's text (a decimal for Number and Money, `YYYY-MM-DD` for Date,
 * a datetime-local `YYYY-MM-DDTHH:mm` for Timestamp, `true` or `false` for Boolean, a choice key for Choice, a
 * person id for Person) and, for Money, the currency code. Blank text means no value.
 */
export interface CustomFieldInput {
  readonly value: string;
  readonly currency?: string | undefined;
}

/** Why a field's input cannot be saved. */
export type CustomFieldProblem = "required" | "invalid" | "currency";

/** What parsing needs beyond the text: the zone a Timestamp is typed in and each currency's minor units. */
export interface CustomFieldParseContext {
  readonly timeZone: string;
  /** Minor unit exponent per currency code; a currency not listed is refused. */
  readonly exponents: ReadonlyMap<string, number>;
}

const SELECT_DEFINITIONS =
  "id, target_table, field_key, label, data_type, required, filterable, sort_order, custom_field_choices(id, choice_key, label, sort_order, deleted_at)";

/** The org's live custom fields on one table, in form order, with their live choices. */
export async function listCustomFieldDefinitions(
  db: XosClient,
  orgId: string,
  table: CustomFieldTable,
): Promise<Result<CustomField[]>> {
  const { data, error } = await db
    .from("custom_field_definitions")
    .select(SELECT_DEFINITIONS)
    .eq("org_id", orgId)
    .eq("target_table", table)
    .is("deleted_at", null)
    .order("sort_order")
    .order("label");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id,
      targetTable: r.target_table,
      key: r.field_key,
      label: r.label,
      dataType: r.data_type,
      required: r.required,
      filterable: r.filterable,
      sortOrder: r.sort_order,
      choices: (r.custom_field_choices ?? [])
        .filter((c) => c.deleted_at === null)
        .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label))
        .map((c) => ({ id: c.id, key: c.choice_key, label: c.label })),
    })),
  );
}

// Typed columns ------------------------------------------------------------------------------------------------

type ValueColumn =
  | "value_text"
  | "value_number"
  | "value_money_minor"
  | "value_date"
  | "value_timestamp"
  | "value_boolean"
  | "value_choice_id"
  | "value_person_id";

/** The column a data type stores its value in (private.check_typed_value, 0540). */
export function valueColumn(type: CustomDataType): ValueColumn {
  switch (type) {
    case "Number":
      return "value_number";
    case "Money":
      return "value_money_minor";
    case "Date":
      return "value_date";
    case "Timestamp":
      return "value_timestamp";
    case "Boolean":
      return "value_boolean";
    case "Choice":
      return "value_choice_id";
    case "Person":
      return "value_person_id";
    default:
      return "value_text";
  }
}

interface ValueRow {
  readonly id: string;
  readonly custom_field_definition_id: string;
  readonly target_id: string;
  readonly value_text: string | null;
  readonly value_number: number | null;
  readonly value_money_minor: number | null;
  readonly value_currency: string | null;
  readonly value_date: string | null;
  readonly value_timestamp: string | null;
  readonly value_boolean: boolean | null;
  readonly value_choice_id: string | null;
  readonly value_person_id: string | null;
}

const VALUE_COLUMNS =
  "id, custom_field_definition_id, target_id, value_text, value_number, value_money_minor, value_currency, value_date, value_timestamp, value_boolean, value_choice_id, value_person_id";

/** A stored row as a typed value; null when the field's column is empty. */
export function valueOfRow(
  type: CustomDataType,
  row: Omit<ValueRow, "id" | "custom_field_definition_id" | "target_id">,
): CustomFieldValue | null {
  switch (type) {
    case "Number":
      return row.value_number === null ? null : { type, number: Number(row.value_number) };
    case "Money":
      return row.value_money_minor === null || row.value_currency === null
        ? null
        : { type, minor: Number(row.value_money_minor), currency: row.value_currency };
    case "Date":
      return row.value_date === null ? null : { type, date: row.value_date };
    case "Timestamp":
      return row.value_timestamp === null ? null : { type, at: row.value_timestamp };
    case "Boolean":
      return row.value_boolean === null ? null : { type, boolean: row.value_boolean };
    case "Choice":
      return row.value_choice_id === null ? null : { type, choiceId: row.value_choice_id };
    case "Person":
      return row.value_person_id === null ? null : { type, personId: row.value_person_id };
    default:
      return row.value_text === null ? null : { type, text: row.value_text };
  }
}

/** Every typed column of a value row, the value's own filled and the rest cleared. */
export function rowOfValue(
  value: CustomFieldValue,
): Omit<ValueRow, "id" | "custom_field_definition_id" | "target_id"> {
  return {
    value_text:
      value.type === "Text" || value.type === "Email" || value.type === "URL" ? value.text : null,
    value_number: value.type === "Number" ? value.number : null,
    value_money_minor: value.type === "Money" ? value.minor : null,
    value_currency: value.type === "Money" ? value.currency : null,
    value_date: value.type === "Date" ? value.date : null,
    value_timestamp: value.type === "Timestamp" ? value.at : null,
    value_boolean: value.type === "Boolean" ? value.boolean : null,
    value_choice_id: value.type === "Choice" ? value.choiceId : null,
    value_person_id: value.type === "Person" ? value.personId : null,
  };
}

// Reading values -----------------------------------------------------------------------------------------------

/** Target ids per request: keeps each `in.(...)` list well inside a URL. */
const ID_CHUNK = 150;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The values of the given fields on the given rows, as `targetId -> fieldKey -> value`. Rows the caller cannot
 * read have no values here (row level security on custom_field_values follows the row, invariant 2).
 */
export async function listCustomFieldValues(
  db: XosClient,
  fields: readonly CustomField[],
  targetIds: readonly string[],
): Promise<Result<Map<string, Record<string, CustomFieldValue>>>> {
  const out = new Map<string, Record<string, CustomFieldValue>>();
  const ids = [...new Set(targetIds)];
  if (fields.length === 0 || ids.length === 0) return ok(out);
  const byId = new Map(fields.map((f) => [f.id, f]));
  const reads = await Promise.all(
    chunks(ids, ID_CHUNK).map((part) =>
      db
        .from("custom_field_values")
        .select(VALUE_COLUMNS)
        .in("custom_field_definition_id", [...byId.keys()])
        .in("target_id", part)
        .is("deleted_at", null),
    ),
  );
  for (const read of reads) {
    if (read.error) return fail(toDataError(read.error));
    for (const row of read.data as ValueRow[]) {
      const field = byId.get(row.custom_field_definition_id);
      const value = field ? valueOfRow(field.dataType, row) : null;
      if (!field || !value) continue;
      const values = out.get(row.target_id) ?? {};
      values[field.key] = value;
      out.set(row.target_id, values);
    }
  }
  return ok(out);
}

// Parsing what a form holds ------------------------------------------------------------------------------------

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const URL_TEXT = /^https?:\/\/[^\s]+$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 10_000;

/** A decimal typed as text ("1,250.50") as minor units at an exponent; null when malformed or too precise. */
export function decimalToMinor(text: string, exponent: number): number | null {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(text.trim().replace(/,/g, ""));
  if (!match) return null;
  const [, sign, whole = "0", fraction = ""] = match;
  if (fraction.length > exponent) return null;
  const minor = Number(whole) * 10 ** exponent + Number(fraction.padEnd(exponent, "0") || "0");
  if (!Number.isSafeInteger(minor)) return null;
  return sign === "-" ? -minor : minor;
}

/** Minor units as the decimal a person types; the inverse of `decimalToMinor`. */
export function minorToDecimal(minor: number, exponent: number): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const scale = 10 ** exponent;
  const fraction = exponent > 0 ? `.${String(abs % scale).padStart(exponent, "0")}` : "";
  return `${negative ? "-" : ""}${Math.floor(abs / scale)}${fraction}`;
}

function isRealDate(text: string): boolean {
  return DATE.test(text) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
}

/**
 * One field's input as a typed value: `{ ok: true, value: null }` for a blank input, the value when it parses,
 * or the problem when it does not. Required is not judged here (see `checkCustomFieldInputs`).
 */
export function parseCustomFieldInput(
  field: Pick<CustomField, "dataType" | "choices">,
  input: CustomFieldInput,
  context: CustomFieldParseContext,
): { ok: true; value: CustomFieldValue | null } | { ok: false; problem: CustomFieldProblem } {
  const text = input.value.trim();
  if (text === "") return { ok: true, value: null };
  const invalid = { ok: false as const, problem: "invalid" as const };
  switch (field.dataType) {
    case "Text":
      return text.length > MAX_TEXT ? invalid : { ok: true, value: { type: "Text", text } };
    case "Email":
      return EMAIL.test(text) ? { ok: true, value: { type: "Email", text } } : invalid;
    case "URL":
      return URL_TEXT.test(text) ? { ok: true, value: { type: "URL", text } } : invalid;
    case "Number": {
      const normalized = text.replace(/,/g, "");
      if (!/^-?[0-9]+(\.[0-9]+)?$/.test(normalized)) return invalid;
      return { ok: true, value: { type: "Number", number: Number(normalized) } };
    }
    case "Money": {
      const currency = (input.currency ?? "").trim().toUpperCase();
      const exponent = context.exponents.get(currency);
      if (exponent === undefined) return { ok: false, problem: "currency" };
      const minor = decimalToMinor(text, exponent);
      return minor === null ? invalid : { ok: true, value: { type: "Money", minor, currency } };
    }
    case "Date":
      return isRealDate(text) ? { ok: true, value: { type: "Date", date: text } } : invalid;
    case "Timestamp": {
      const at = instantOfLocalIn(text, context.timeZone);
      return at === null || !isRealDate(text.slice(0, 10))
        ? invalid
        : { ok: true, value: { type: "Timestamp", at } };
    }
    case "Boolean":
      if (text === "true") return { ok: true, value: { type: "Boolean", boolean: true } };
      if (text === "false") return { ok: true, value: { type: "Boolean", boolean: false } };
      return invalid;
    case "Choice": {
      const choice = field.choices.find((c) => c.key === text || c.id === text);
      return choice ? { ok: true, value: { type: "Choice", choiceId: choice.id } } : invalid;
    }
    case "Person":
      return UUID.test(text) ? { ok: true, value: { type: "Person", personId: text } } : invalid;
  }
}

/** The outcome of checking a form's custom field inputs. */
export interface CustomFieldCheck {
  /** Field id to its new value (null clears it), for the fields the form sent. */
  readonly values: ReadonlyMap<string, CustomFieldValue | null>;
  /** Field key to its problem; empty when every input can be saved. */
  readonly problems: Readonly<Record<string, CustomFieldProblem>>;
}

/**
 * Checks a form's inputs, keyed by field key, against the table's fields. Creating a row needs a value for every
 * required field; an update judges only the fields the form sent, and a required field it sends blank is refused,
 * as the database refuses clearing one (1760). Inputs naming no live field are ignored.
 */
export function checkCustomFieldInputs(
  fields: readonly CustomField[],
  inputs: Readonly<Record<string, CustomFieldInput>>,
  mode: "create" | "update",
  context: CustomFieldParseContext,
): CustomFieldCheck {
  const values = new Map<string, CustomFieldValue | null>();
  const problems: Record<string, CustomFieldProblem> = {};
  for (const field of fields) {
    const input = inputs[field.key];
    if (input === undefined) {
      if (mode === "create" && field.required) problems[field.key] = "required";
      continue;
    }
    const parsed = parseCustomFieldInput(field, input, context);
    if (!parsed.ok) {
      problems[field.key] = parsed.problem;
    } else if (parsed.value === null && field.required) {
      problems[field.key] = "required";
    } else {
      values.set(field.id, parsed.value);
    }
  }
  return { values, problems };
}

/**
 * A typed value as the text its input holds, for editing: the inverse of `parseCustomFieldInput`. A choice
 * shows its key; a timestamp its wall-clock time in the zone.
 */
export function inputOfValue(
  value: CustomFieldValue,
  field: Pick<CustomField, "choices">,
  context: CustomFieldParseContext,
): CustomFieldInput {
  switch (value.type) {
    case "Number":
      return { value: String(value.number) };
    case "Money":
      return {
        value: minorToDecimal(value.minor, context.exponents.get(value.currency) ?? 2),
        currency: value.currency,
      };
    case "Date":
      return { value: value.date };
    case "Timestamp":
      return { value: localTimeIn(value.at, context.timeZone) };
    case "Boolean":
      return { value: value.boolean ? "true" : "false" };
    case "Choice":
      return { value: field.choices.find((c) => c.id === value.choiceId)?.key ?? "" };
    case "Person":
      return { value: value.personId };
    default:
      return { value: value.text };
  }
}

/** An instant as the `YYYY-MM-DDTHH:mm` wall-clock time of a zone (a datetime-local input's value). */
export function localTimeIn(instant: string, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

// Writing values -----------------------------------------------------------------------------------------------

/**
 * Writes one row's values: a new value is inserted, a changed one updated in place (its typed column filled and
 * every other cleared), and a cleared one soft deleted, so its history stays in the audit trail. Stops at the
 * first refusal, which comes back as the database named it (custom_value_required, custom_value_choice, ...).
 */
export async function writeCustomFieldValues(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly targetId: string;
    readonly values: ReadonlyMap<string, CustomFieldValue | null>;
  },
): Promise<Result<null>> {
  const fieldIds = [...input.values.keys()];
  if (fieldIds.length === 0) return ok(null);
  const { data, error } = await db
    .from("custom_field_values")
    .select("id, custom_field_definition_id")
    .eq("target_id", input.targetId)
    .in("custom_field_definition_id", fieldIds)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  const existing = new Map(
    (data as { id: string; custom_field_definition_id: string }[]).map((r) => [
      r.custom_field_definition_id,
      r.id,
    ]),
  );
  for (const [fieldId, value] of input.values) {
    const id = existing.get(fieldId);
    let written: { error: { code?: string; message: string; hint?: string | null } | null };
    if (value === null) {
      if (id === undefined) continue;
      written = await db
        .from("custom_field_values")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);
    } else if (id === undefined) {
      written = await db.from("custom_field_values").insert({
        org_id: input.orgId,
        custom_field_definition_id: fieldId,
        target_id: input.targetId,
        ...rowOfValue(value),
      });
    } else {
      written = await db.from("custom_field_values").update(rowOfValue(value)).eq("id", id);
    }
    if (written.error) return fail(toDataError(written.error));
  }
  return ok(null);
}

// Filtering rows by their values -------------------------------------------------------------------------------

/** Filter operators the API grammar names (app.filter_operator, ADR 0003). */
export type CustomFieldOperator =
  "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "contains" | "is_null";

/** One view filter on a custom field: the field key, the operator and the value as the URL carries it. */
export interface CustomFieldCondition {
  readonly key: string;
  readonly operator: CustomFieldOperator;
  readonly value: string;
}

/** The operators a data type offers in a filter, the first being the default. */
export function operatorsFor(type: CustomDataType): readonly CustomFieldOperator[] {
  switch (type) {
    case "Text":
    case "Email":
    case "URL":
      return ["contains", "eq", "ne", "is_null"];
    case "Number":
    case "Money":
      return ["eq", "ne", "gt", "gte", "lt", "lte", "is_null"];
    case "Date":
    case "Timestamp":
      return ["eq", "gte", "lte", "is_null"];
    case "Boolean":
      return ["eq"];
    case "Choice":
    case "Person":
      return ["eq", "ne", "is_null"];
  }
}

/** Rows per page when reading matching ids, the API's max_rows (supabase/config.toml). */
const PAGE = 1000;

type Filterable = {
  eq(column: string, value: unknown): Filterable;
  gt(column: string, value: unknown): Filterable;
  gte(column: string, value: unknown): Filterable;
  lt(column: string, value: unknown): Filterable;
  lte(column: string, value: unknown): Filterable;
  ilike(column: string, pattern: string): Filterable;
  not(column: string, operator: string, value: unknown): Filterable;
};

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The narrowing a condition applies to the value rows of its field, or null when its value cannot match anything
 * (a malformed number, an unknown choice). `scan` says whether matching rows are kept (`include`) or dropped
 * (`exclude`): "is not" and "is empty" drop the rows whose value matches the opposite test, so rows without a
 * value pass them.
 */
function narrowing(
  field: CustomField,
  condition: CustomFieldCondition,
  timeZone: string,
): { scan: "include" | "exclude"; apply: (q: Filterable) => Filterable } | null {
  const column = valueColumn(field.dataType);
  const value = condition.value.trim();
  if (condition.operator === "is_null") {
    const hasValue = (q: Filterable) => q.not(column, "is", null);
    return { scan: value === "false" ? "include" : "exclude", apply: hasValue };
  }
  if (condition.operator === "ne") {
    const equal = narrowing(field, { ...condition, operator: "eq" }, timeZone);
    return equal ? { scan: "exclude", apply: equal.apply } : null;
  }
  const compare = (operand: unknown) => (q: Filterable) => {
    switch (condition.operator) {
      case "gt":
        return q.gt(column, operand);
      case "gte":
        return q.gte(column, operand);
      case "lt":
        return q.lt(column, operand);
      case "lte":
        return q.lte(column, operand);
      default:
        return q.eq(column, operand);
    }
  };
  switch (field.dataType) {
    case "Text":
    case "Email":
    case "URL": {
      const pattern = escapeLike(value);
      if (condition.operator === "contains")
        return { scan: "include", apply: (q) => q.ilike(column, `%${pattern}%`) };
      return condition.operator === "eq"
        ? { scan: "include", apply: (q) => q.ilike(column, pattern) }
        : null;
    }
    case "Number": {
      const normalized = value.replace(/,/g, "");
      if (!/^-?[0-9]+(\.[0-9]+)?$/.test(normalized) || condition.operator === "contains")
        return null;
      return { scan: "include", apply: compare(Number(normalized)) };
    }
    case "Money": {
      // Filters compare amounts in major units of two-decimal currencies, the money the org settles in.
      const minor = decimalToMinor(value, 2);
      if (minor === null || condition.operator === "contains") return null;
      return { scan: "include", apply: compare(minor) };
    }
    case "Date":
      if (!isRealDate(value) || !["eq", "gt", "gte", "lt", "lte"].includes(condition.operator))
        return null;
      return { scan: "include", apply: compare(value) };
    case "Timestamp": {
      // A timestamp filter names a day on the org's calendar.
      if (!isRealDate(value)) return null;
      const start = startOfDayIn(value, timeZone);
      const next = startOfDayIn(addCalendarDays(value, 1), timeZone);
      switch (condition.operator) {
        case "eq":
          return { scan: "include", apply: (q) => q.gte(column, start).lt(column, next) };
        case "gte":
          return { scan: "include", apply: (q) => q.gte(column, start) };
        case "gt":
          return { scan: "include", apply: (q) => q.gte(column, next) };
        case "lte":
          return { scan: "include", apply: (q) => q.lt(column, next) };
        case "lt":
          return { scan: "include", apply: (q) => q.lt(column, start) };
        default:
          return null;
      }
    }
    case "Boolean":
      if (condition.operator !== "eq" || (value !== "true" && value !== "false")) return null;
      return { scan: "include", apply: (q) => q.eq(column, value === "true") };
    case "Choice": {
      const choice = field.choices.find((c) => c.key === value);
      return choice && condition.operator === "eq"
        ? { scan: "include", apply: (q) => q.eq(column, choice.id) }
        : null;
    }
    case "Person":
      return UUID.test(value) && condition.operator === "eq"
        ? { scan: "include", apply: (q) => q.eq(column, value) }
        : null;
  }
}

/**
 * Which rows of a table pass every condition, judged on custom_field_values with the field's typed column (its
 * partial index when the field is filterable, 0540). Conditions on unknown or unfilterable fields are ignored;
 * a condition whose value cannot match leaves no row. The predicate answers for any row id; rows without values
 * pass "is not" and "is empty" and fail every other test.
 */
export async function matchCustomFieldConditions(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly fields: readonly CustomField[];
    readonly conditions: readonly CustomFieldCondition[];
    /** The org's zone, which a Timestamp filter's day is read in. */
    readonly timeZone: string;
  },
): Promise<Result<((targetId: string) => boolean) | null>> {
  const tests: { scan: "include" | "exclude"; ids: Set<string> }[] = [];
  let none = false;
  for (const condition of input.conditions) {
    const field = input.fields.find((f) => f.key === condition.key && f.filterable);
    if (!field) continue;
    const narrow = narrowing(field, condition, input.timeZone);
    if (!narrow) {
      none = true;
      continue;
    }
    const ids = new Set<string>();
    for (let from = 0; ; from += PAGE) {
      const base = db
        .from("custom_field_values")
        .select("target_id")
        .eq("org_id", input.orgId)
        .eq("custom_field_definition_id", field.id)
        .is("deleted_at", null);
      const { data, error } = await (
        narrow.apply(base as unknown as Filterable) as unknown as typeof base
      )
        .order("target_id")
        .range(from, from + PAGE - 1);
      if (error) return fail(toDataError(error));
      for (const row of data as { target_id: string }[]) ids.add(row.target_id);
      if (data.length < PAGE) break;
    }
    tests.push({ scan: narrow.scan, ids });
  }
  if (none) return ok(() => false);
  if (tests.length === 0) return ok(null);
  return ok((id) => tests.every((t) => (t.scan === "include" ? t.ids.has(id) : !t.ids.has(id))));
}
