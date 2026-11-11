import type {
  CustomField,
  CustomFieldInput,
  CustomFieldProblem,
  CustomFieldTable,
  CustomFieldValue,
} from "@xos/data/custom-fields";

/**
 * What the server hands the custom field components (A117): plain data, so a server page or a server action can
 * pass it to the browser. Labels are the org's own text; every other string comes from the catalogs.
 */

export type {
  CustomField,
  CustomFieldInput,
  CustomFieldProblem,
  CustomFieldTable,
  CustomFieldValue,
};

export interface CustomFieldPerson {
  readonly id: string;
  readonly name: string;
}

export interface CustomFieldCurrency {
  readonly code: string;
  readonly exponent: number;
}

/** A form's custom fields: the table's fields and, when editing a row, its current values. */
export interface CustomFieldForm {
  readonly table: CustomFieldTable;
  /** The row edited; null on a create form. */
  readonly targetId: string | null;
  readonly fields: readonly CustomField[];
  /** The row's values as their inputs hold them, by field key. */
  readonly inputs: Readonly<Record<string, CustomFieldInput>>;
  /** The row's values, by field key, for showing them. */
  readonly values: Readonly<Record<string, CustomFieldValue>>;
  /** The org's members, when a Person field needs them. */
  readonly people: readonly CustomFieldPerson[];
  /** Currencies and their minor units, when a Money field needs them. */
  readonly currencies: readonly CustomFieldCurrency[];
  readonly defaultCurrency: string;
  /** The org's zone, which Timestamp values are typed and shown in. */
  readonly timeZone: string;
  /** True when the viewer may write custom field values (Collaborator band or higher, 0540). */
  readonly canWrite: boolean;
}

/** The filterable custom fields of a list and their values on the rows shown, as text (table columns, filters). */
export interface CustomFieldListView {
  readonly table: CustomFieldTable;
  readonly fields: readonly CustomField[];
  /**
   * Row id to column key (`cf.<key>`) to the value as display text, or null for none. The server formats them
   * in the viewer's locale, so a table shows them without the formatting code (A24-009).
   */
  readonly cells: Readonly<Record<string, Readonly<Record<string, string | null>>>>;
  /** Person id to name, for Person values and the Person filter. */
  readonly people: Readonly<Record<string, string>>;
  readonly timeZone: string;
}

export type CustomFieldSaveResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** Field key to problem, when inputs failed the checks. */
      readonly problems?: Readonly<Record<string, CustomFieldProblem>>;
      /** A refusal rule the database named, or a general error key. */
      readonly error?: string;
    };
