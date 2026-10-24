import { SYSTEM_ROLE_CODES } from "@xos/data";
import {
  checkCustomFieldInputs,
  inputOfValue,
  listCustomFieldDefinitions,
  listCustomFieldValues,
  matchCustomFieldConditions,
  writeCustomFieldValues,
  type CustomField,
  type CustomFieldInput,
  type CustomFieldTable,
  type CustomFieldValue,
} from "@xos/data/custom-fields";
import { listCurrencies } from "@xos/data/procurement";
import { getOrgSettingValue } from "@xos/data/settings";
import { listPeopleRefs } from "@xos/data/work";
import { cache } from "react";
import { customConditionsOf } from "@/lib/views/conditions";
import type { OrgContext } from "@/lib/shell/context";
import { getOrgTimeZone } from "@/lib/shell/time-zone";
import type {
  CustomFieldCurrency,
  CustomFieldForm,
  CustomFieldProblem,
  CustomFieldListView,
  CustomFieldPerson,
  CustomFieldSaveResult,
} from "./types";

/**
 * Server half of custom fields on Atlas pages (A117, RRR-162): the forms' fields and values, the save every form
 * and record section calls, and the filterable fields a list shows as columns and filters on. Reads and writes
 * go through @xos/data/custom-fields with the viewer's own client, so row level security decides.
 */

type Search = URLSearchParams | Readonly<Record<string, string | string[] | undefined>>;

/** The org's live fields on a table, once per request. */
const definitions = cache(
  async (ctx: OrgContext, table: CustomFieldTable): Promise<CustomField[]> => {
    const result = await listCustomFieldDefinitions(ctx.viewer.db, ctx.org.id, table);
    if (!result.ok) {
      // A page still works without its custom fields; the failure is logged, not shown.
      console.error(`Custom fields of ${table} could not be read`, result.error);
      return [];
    }
    return result.data;
  },
);

const currencies = cache(async (ctx: OrgContext): Promise<CustomFieldCurrency[]> => {
  const result = await listCurrencies(ctx.viewer.db);
  return result.ok ? result.data.map((c) => ({ code: c.code, exponent: c.minorUnits })) : [];
});

const people = cache(async (ctx: OrgContext): Promise<CustomFieldPerson[]> => {
  const result = await listPeopleRefs(ctx.viewer.db, ctx.org.id);
  return result.ok
    ? result.data.map((p) => ({ id: p.personId, name: p.name ?? p.personId.slice(0, 8) }))
    : [];
});

/** Collaborator band or higher writes custom field values (private.custom_writer_orgs, 0540). */
export function canWriteCustomFields(ctx: OrgContext): boolean {
  const band = ctx.role ? SYSTEM_ROLE_CODES.indexOf(ctx.role) + 1 : 0;
  return band >= 1 && band <= 5;
}

async function parseContext(ctx: OrgContext, fields: readonly CustomField[]) {
  const money = fields.some((f) => f.dataType === "Money");
  const list = money ? await currencies(ctx) : [];
  return {
    timeZone: await getOrgTimeZone(ctx),
    exponents: new Map(list.map((c) => [c.code, c.exponent])),
    currencies: list,
  };
}

/** A form's custom fields: the table's fields and, with a row id, that row's values. */
export async function loadCustomFieldForm(
  ctx: OrgContext,
  table: CustomFieldTable,
  targetId: string | null,
): Promise<CustomFieldForm> {
  const fields = await definitions(ctx, table);
  const context = await parseContext(ctx, fields);
  const [values, members, base] = await Promise.all([
    targetId && fields.length > 0
      ? listCustomFieldValues(ctx.viewer.db, fields, [targetId])
      : Promise.resolve(null),
    fields.some((f) => f.dataType === "Person") ? people(ctx) : Promise.resolve([]),
    fields.some((f) => f.dataType === "Money")
      ? getOrgSettingValue(ctx.viewer.db, ctx.org.id, "org.base_currency")
      : Promise.resolve(null),
  ]);
  const own: Record<string, CustomFieldValue> =
    values && values.ok && targetId ? (values.data.get(targetId) ?? {}) : {};
  const inputs: Record<string, CustomFieldInput> = {};
  for (const field of fields) {
    const value = own[field.key];
    if (value) inputs[field.key] = inputOfValue(value, field, context);
  }
  const stored = base && base.ok && typeof base.data === "string" ? base.data : null;
  return {
    table,
    targetId,
    fields,
    inputs,
    values: own,
    people: members,
    currencies: context.currencies,
    defaultCurrency:
      stored && context.exponents.has(stored)
        ? stored
        : context.exponents.has("USD")
          ? "USD"
          : (context.currencies[0]?.code ?? "USD"),
    timeZone: context.timeZone,
    canWrite: canWriteCustomFields(ctx),
  };
}

/**
 * Checks a row's custom field inputs and writes them. Creating needs every required field; an update judges the
 * fields sent. Nothing is written when an input fails, and a database refusal comes back by its rule.
 */
export async function saveCustomFields(
  ctx: OrgContext,
  input: {
    readonly table: CustomFieldTable;
    readonly targetId: string;
    readonly inputs: Readonly<Record<string, CustomFieldInput>>;
    readonly mode: "create" | "update";
    /** Checks the inputs without writing (a create form's check before its row exists). */
    readonly dryRun?: boolean;
  },
): Promise<CustomFieldSaveResult> {
  const fields = await definitions(ctx, input.table);
  if (fields.length === 0) return { ok: true };
  const context = await parseContext(ctx, fields);
  const check = checkCustomFieldInputs(fields, input.inputs, input.mode, context);
  const problems: Record<string, CustomFieldProblem> = { ...check.problems };
  // A person value names a member of the org, as the 0540 guard requires.
  const personFields = fields.filter((f) => f.dataType === "Person" && check.values.get(f.id));
  if (personFields.length > 0) {
    const members = new Set((await people(ctx)).map((p) => p.id));
    for (const field of personFields) {
      const value = check.values.get(field.id);
      if (value?.type === "Person" && !members.has(value.personId)) problems[field.key] = "invalid";
    }
  }
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  if (input.dryRun) return { ok: true };
  const written = await writeCustomFieldValues(ctx.viewer.db, {
    orgId: ctx.org.id,
    targetId: input.targetId,
    values: check.values,
  });
  if (written.ok) return { ok: true };
  const error = written.error;
  if (error.kind === "refusal") return { ok: false, error: error.rule };
  if (error.kind === "not-found") return { ok: false, error: "denied" };
  console.error(`Custom fields of ${input.table} could not be saved`, error);
  return { ok: false, error: "unexpected" };
}

/** A list's custom fields: which rows pass the query's conditions, and the view its columns and filters read. */
export interface CustomFieldList {
  /** True for a row that passes every custom field condition (always true without conditions). */
  readonly keep: (id: string) => boolean;
  /** The filterable fields and their values on the rows shown; null when the table has none. */
  readonly view: (ids: readonly string[]) => Promise<CustomFieldListView | null>;
}

const EMPTY_LIST: CustomFieldList = { keep: () => true, view: async () => null };

/**
 * The custom fields of a list page. The loader keeps the rows `keep` passes (the query's `cf.*` conditions,
 * judged on custom_field_values) and hands `await view(shownIds)` to the collection, whose table shows the
 * filterable fields as columns and whose Add filter control offers them. A table without filterable fields
 * costs one read.
 */
export async function customFieldList(
  ctx: OrgContext,
  table: CustomFieldTable,
  search: Search,
): Promise<CustomFieldList> {
  const fields = (await definitions(ctx, table)).filter((f) => f.filterable);
  if (fields.length === 0) return EMPTY_LIST;
  const timeZone = await getOrgTimeZone(ctx);
  const conditions = customConditionsOf(search);
  let keep: (id: string) => boolean = () => true;
  if (conditions.length > 0) {
    const matched = await matchCustomFieldConditions(ctx.viewer.db, {
      orgId: ctx.org.id,
      fields,
      conditions,
      timeZone,
    });
    // The person asked for these rows; showing every row instead would mislead.
    if (!matched.ok) throw new Error(`Cannot filter ${table}: ${JSON.stringify(matched.error)}`);
    if (matched.data) keep = matched.data;
  }
  return {
    keep,
    view: async (ids) => {
      const [values, members] = await Promise.all([
        listCustomFieldValues(ctx.viewer.db, fields, ids),
        fields.some((f) => f.dataType === "Person") ? people(ctx) : Promise.resolve([]),
      ]);
      if (!values.ok)
        console.error(`Custom field values of ${table} could not be read`, values.error);
      return {
        table,
        fields,
        values: values.ok ? Object.fromEntries(values.data) : {},
        people: Object.fromEntries(members.map((p) => [p.id, p.name])),
        timeZone,
      };
    },
  };
}
