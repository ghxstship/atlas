import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { num, numOrNull, rows, str, strOrNull, writtenId, type Raw } from "./platform-common.ts";
import { untyped } from "./untyped.ts";

/**
 * Custom objects (A36 on A18's 0540; Section 4.6.3): org-defined types with typed fields, their records
 * and one value row per record and field in the typed column of the field's data type (no JSON). Read
 * and written as the caller: members read, Collaborators and above write records, holders of
 * org.custom_objects.write define types and fields.
 */

export const CUSTOM_DATA_TYPES = [
  "Text",
  "Number",
  "Money",
  "Date",
  "Timestamp",
  "Boolean",
  "Choice",
  "Person",
  "Email",
  "URL",
] as const;
export type CustomDataType = (typeof CUSTOM_DATA_TYPES)[number];

export const OBJECT_VIEWS = ["List", "Board", "Table", "Calendar"] as const;
export type ObjectView = (typeof OBJECT_VIEWS)[number];

export interface FieldChoice {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly order: number;
}

export interface ObjectField {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly dataType: CustomDataType;
  readonly required: boolean;
  readonly filterable: boolean;
  readonly order: number;
  readonly choices: readonly FieldChoice[];
}

export interface ObjectType {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly icon: string;
  readonly defaultView: ObjectView | "Timeline";
  readonly fields: readonly ObjectField[];
}

const TYPE_SELECT =
  "id, object_key, label, icon, default_view, custom_object_fields (id, field_key, label, data_type, required, filterable, sort_order, deleted_at, custom_object_field_choices (id, choice_key, label, sort_order, deleted_at))";

function toType(r: Raw): ObjectType {
  const fields = ((r["custom_object_fields"] as Raw[] | null) ?? [])
    .filter((f) => f["deleted_at"] === null || f["deleted_at"] === undefined)
    .map((f) => ({
      id: str(f["id"]),
      key: str(f["field_key"]),
      label: str(f["label"]),
      dataType: str(f["data_type"]) as CustomDataType,
      required: f["required"] === true,
      filterable: f["filterable"] === true,
      order: num(f["sort_order"]),
      choices: ((f["custom_object_field_choices"] as Raw[] | null) ?? [])
        .filter((c) => c["deleted_at"] === null || c["deleted_at"] === undefined)
        .map((c) => ({
          id: str(c["id"]),
          key: str(c["choice_key"]),
          label: str(c["label"]),
          order: num(c["sort_order"]),
        }))
        .sort((a, b) => a.order - b.order),
    }))
    .sort((a, b) => a.order - b.order);
  return {
    id: str(r["id"]),
    key: str(r["object_key"]),
    label: str(r["label"]),
    icon: str(r["icon"]),
    defaultView: str(r["default_view"]) as ObjectView,
    fields,
  };
}

export async function listObjectTypes(db: XosClient, orgId: string): Promise<Result<ObjectType[]>> {
  const result = await rows(
    untyped(db)
      .from("custom_object_types")
      .select(TYPE_SELECT)
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("label"),
  );
  if (!result.ok) return result;
  return ok(result.data.map(toType));
}

/** The org's object with this key, or not-found. */
export async function getObjectType(
  db: XosClient,
  orgId: string,
  key: string,
): Promise<Result<ObjectType>> {
  const result = await rows(
    untyped(db)
      .from("custom_object_types")
      .select(TYPE_SELECT)
      .eq("org_id", orgId)
      .eq("object_key", key)
      .is("deleted_at", null)
      .limit(1),
  );
  if (!result.ok) return result;
  const row = result.data[0];
  return row ? ok(toType(row)) : fail({ kind: "not-found" });
}

export interface NewObjectType {
  readonly orgId: string;
  readonly key: string;
  readonly label: string;
  readonly icon: string;
  readonly defaultView: ObjectView;
}

export function createObjectType(db: XosClient, input: NewObjectType): Promise<Result<string>> {
  return writtenId(
    untyped(db)
      .from("custom_object_types")
      .insert({
        org_id: input.orgId,
        object_key: input.key,
        label: input.label,
        icon: input.icon,
        default_view: input.defaultView,
      })
      .select("id"),
  );
}

export interface NewObjectField {
  readonly typeId: string;
  readonly key: string;
  readonly label: string;
  readonly dataType: CustomDataType;
  readonly required: boolean;
  readonly order: number;
  /** Options of a Choice field, in order. */
  readonly choices?: readonly string[];
}

/** A lowercase key from a label: letters and digits joined by underscores, starting with a letter. */
export function keyFromLabel(label: string): string {
  const key = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "");
  return key.slice(0, 48);
}

export async function addObjectField(
  db: XosClient,
  input: NewObjectField,
): Promise<Result<string>> {
  const field = await writtenId(
    untyped(db)
      .from("custom_object_fields")
      .insert({
        custom_object_type_id: input.typeId,
        field_key: input.key,
        label: input.label,
        data_type: input.dataType,
        required: input.required,
        filterable: input.dataType === "Choice",
        sort_order: input.order,
      })
      .select("id"),
  );
  if (!field.ok || input.dataType !== "Choice") return field;
  const choices = (input.choices ?? []).map((label, i) => ({
    custom_object_field_id: field.data,
    choice_key: keyFromLabel(label) || `option_${i + 1}`,
    label,
    sort_order: i + 1,
  }));
  if (choices.length > 0) {
    const { error } = await untyped(db).from("custom_object_field_choices").insert(choices);
    if (error) return fail(toDataError(error));
  }
  return field;
}

// Records ---------------------------------------------------------------------------------------------------

export type FieldValue =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "money"; readonly minor: number | null; readonly currency: string }
  | { readonly kind: "date"; readonly value: string }
  | { readonly kind: "timestamp"; readonly value: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "choice"; readonly choiceId: string }
  | { readonly kind: "person"; readonly personId: string };

export interface ObjectRecord {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Values by field id; a field without a value is absent. */
  readonly values: Readonly<Record<string, FieldValue>>;
}

const VALUE_COLUMNS =
  "custom_object_field_id, value_text, value_number, value_money_minor, value_currency, value_date, value_timestamp, value_boolean, value_choice_id, value_person_id, deleted_at";

function toValue(field: ObjectField | undefined, v: Raw): FieldValue | null {
  if (!field) return null;
  switch (field.dataType) {
    case "Text":
    case "Email":
    case "URL":
      return v["value_text"] === null ? null : { kind: "text", value: str(v["value_text"]) };
    case "Number":
      return v["value_number"] === null ? null : { kind: "number", value: num(v["value_number"]) };
    case "Money":
      return v["value_currency"] === null
        ? null
        : {
            kind: "money",
            minor: numOrNull(v["value_money_minor"]),
            currency: str(v["value_currency"]),
          };
    case "Date":
      return v["value_date"] === null ? null : { kind: "date", value: str(v["value_date"]) };
    case "Timestamp":
      return v["value_timestamp"] === null
        ? null
        : { kind: "timestamp", value: str(v["value_timestamp"]) };
    case "Boolean":
      return v["value_boolean"] === null
        ? null
        : { kind: "boolean", value: v["value_boolean"] === true };
    case "Choice":
      return v["value_choice_id"] === null
        ? null
        : { kind: "choice", choiceId: str(v["value_choice_id"]) };
    case "Person":
      return v["value_person_id"] === null
        ? null
        : { kind: "person", personId: str(v["value_person_id"]) };
  }
}

export async function listObjectRecords(
  db: XosClient,
  type: ObjectType,
): Promise<Result<ObjectRecord[]>> {
  const result = await rows(
    untyped(db)
      .from("custom_object_records")
      .select(`id, title, created_at, updated_at, custom_object_values (${VALUE_COLUMNS})`)
      .eq("custom_object_type_id", type.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(500),
  );
  if (!result.ok) return result;
  const fields = new Map(type.fields.map((f) => [f.id, f]));
  return ok(
    result.data.map((r) => {
      const values: Record<string, FieldValue> = {};
      for (const v of (r["custom_object_values"] as Raw[] | null) ?? []) {
        if (v["deleted_at"] !== null && v["deleted_at"] !== undefined) continue;
        const id = str(v["custom_object_field_id"]);
        const value = toValue(fields.get(id), v);
        if (value) values[id] = value;
      }
      return {
        id: str(r["id"]),
        title: str(r["title"]),
        createdAt: str(r["created_at"]),
        updatedAt: str(r["updated_at"]),
        values,
      };
    }),
  );
}

/** The typed columns a value fills, all others null, as the 0540 guard requires. */
export function valueColumns(value: FieldValue): Record<string, unknown> {
  const empty = {
    value_text: null,
    value_number: null,
    value_money_minor: null,
    value_currency: null,
    value_date: null,
    value_timestamp: null,
    value_boolean: null,
    value_choice_id: null,
    value_person_id: null,
  };
  switch (value.kind) {
    case "text":
      return { ...empty, value_text: value.value };
    case "number":
      return { ...empty, value_number: value.value };
    case "money":
      return { ...empty, value_money_minor: value.minor, value_currency: value.currency };
    case "date":
      return { ...empty, value_date: value.value };
    case "timestamp":
      return { ...empty, value_timestamp: value.value };
    case "boolean":
      return { ...empty, value_boolean: value.value };
    case "choice":
      return { ...empty, value_choice_id: value.choiceId };
    case "person":
      return { ...empty, value_person_id: value.personId };
  }
}

/** Creates a record with its values; refusals (a value of the wrong type, a plan limit) come back typed. */
export async function createObjectRecord(
  db: XosClient,
  input: {
    orgId: string;
    typeId: string;
    title: string;
    values: Readonly<Record<string, FieldValue>>;
  },
): Promise<Result<string>> {
  const record = await writtenId(
    untyped(db)
      .from("custom_object_records")
      .insert({ org_id: input.orgId, custom_object_type_id: input.typeId, title: input.title })
      .select("id"),
  );
  if (!record.ok) return record;
  const values = Object.entries(input.values).map(([fieldId, value]) => ({
    custom_object_record_id: record.data,
    custom_object_field_id: fieldId,
    ...valueColumns(value),
  }));
  if (values.length > 0) {
    const { error } = await untyped(db).from("custom_object_values").insert(values);
    if (error) return fail(toDataError(error));
  }
  return record;
}

/** Sets one field of a record, for example its Choice when a card moves to another board column. */
export async function setObjectValue(
  db: XosClient,
  input: { recordId: string; fieldId: string; value: FieldValue },
): Promise<Result<string>> {
  const existing = await rows(
    untyped(db)
      .from("custom_object_values")
      .select("id")
      .eq("custom_object_record_id", input.recordId)
      .eq("custom_object_field_id", input.fieldId)
      .is("deleted_at", null)
      .limit(1),
  );
  if (!existing.ok) return existing;
  const id = existing.data[0]?.["id"];
  if (id) {
    return writtenId(
      untyped(db)
        .from("custom_object_values")
        .update(valueColumns(input.value))
        .eq("id", str(id))
        .select("id"),
    );
  }
  return writtenId(
    untyped(db)
      .from("custom_object_values")
      .insert({
        custom_object_record_id: input.recordId,
        custom_object_field_id: input.fieldId,
        ...valueColumns(input.value),
      })
      .select("id"),
  );
}

/** The first Choice field: the board groups by it. */
export function boardField(type: ObjectType): ObjectField | null {
  return type.fields.find((f) => f.dataType === "Choice") ?? null;
}

/** The first Date or Timestamp field: the calendar places records by it. */
export function calendarField(type: ObjectType): ObjectField | null {
  return type.fields.find((f) => f.dataType === "Date" || f.dataType === "Timestamp") ?? null;
}

/** A short display text of a value for lists and cards; null for no value. */
export function displayValue(field: ObjectField, value: FieldValue | undefined): string | null {
  if (!value) return null;
  switch (value.kind) {
    case "choice":
      return field.choices.find((c) => c.id === value.choiceId)?.label ?? null;
    case "text":
    case "date":
    case "timestamp":
      return value.value;
    case "number":
      return String(value.value);
    case "boolean":
      return value.value ? "true" : "false";
    case "money":
      return value.minor === null ? null : `${value.minor} ${value.currency}`;
    case "person":
      return strOrNull(value.personId);
  }
}
