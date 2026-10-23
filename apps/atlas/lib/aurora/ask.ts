/**
 * Ask in plain language on a collection page (Section 4.7, A95, finding A65-020). A page offers its
 * own filters, the query parameters it already reads (`state=Issued`, `q=Acme`, `overdue=true`), as
 * a catalog: what each means in a sentence for the model, its type, its values and the one operator
 * it takes. aurora.filter turns the person's sentence into conditions over that catalog only; the
 * person edits them; applying them rewrites the page's query string, so the filtered page is an
 * ordinary link and a saved view keeps it (Section 11.15). Pure, for the server pages and the panel.
 */

export type AskOp = "eq" | "contains";

export interface AskField {
  /** The query parameter, such as `state`. */
  readonly name: string;
  /** Its label in the person's language. */
  readonly label: string;
  readonly type: "string" | "date" | "boolean" | "enum";
  /** For an enum, every value with its label; for a boolean, the labels of true and false. */
  readonly values?: readonly { readonly value: string; readonly label: string }[];
  /** What it means, in an English sentence for the model; never record data. */
  readonly description: string;
  /** The one operator the page applies: equality, or containment for text search. */
  readonly op: AskOp;
}

export interface AskCatalog {
  /** The API collection the page lists, for the request log and the Restricted column check. */
  readonly collection: string;
  /** The collection's name in the person's language, for the panel. */
  readonly label: string;
  readonly fields: readonly AskField[];
}

export interface AskCondition {
  readonly field: string;
  readonly op: string;
  readonly value: string;
}

/** The catalog as aurora.filter takes it: names, types, values, meanings and operators only. */
export function catalogForApi(catalog: AskCatalog) {
  return catalog.fields.map((f) => ({
    name: f.name,
    type: f.type,
    ...(f.type === "enum" && f.values ? { values: f.values.map((v) => v.value) } : {}),
    description: f.description,
    ops: [f.op],
  }));
}

/** True when the condition fits the catalog: a known field, its operator and an allowed value. */
export function fits(catalog: AskCatalog, condition: AskCondition): boolean {
  const field = catalog.fields.find((f) => f.name === condition.field);
  if (!field || field.op !== condition.op || condition.value.trim() === "") return false;
  if (field.type === "enum") return (field.values ?? []).some((v) => v.value === condition.value);
  if (field.type === "boolean") return condition.value === "true" || condition.value === "false";
  if (field.type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(condition.value);
  return condition.value.length <= 200;
}

/**
 * The page's query string with the conditions applied: every catalog parameter is replaced (one not
 * among the conditions is cleared), the view, sort and grouping stay, and navigation (an open peek
 * or form) closes. A condition that does not fit the catalog is returned in `skipped`, not applied.
 */
export function applyConditions(
  catalog: AskCatalog,
  current: URLSearchParams,
  conditions: readonly AskCondition[],
): { readonly query: string; readonly skipped: readonly AskCondition[] } {
  const next = new URLSearchParams(current.toString());
  for (const key of ["peek", "full", "create", "edit", "new"]) next.delete(key);
  for (const field of catalog.fields) next.delete(field.name);
  const skipped: AskCondition[] = [];
  for (const condition of conditions) {
    if (fits(catalog, condition) && !next.has(condition.field)) {
      next.set(condition.field, condition.value.trim());
    } else {
      skipped.push(condition);
    }
  }
  return { query: next.toString(), skipped };
}

/** One condition in the person's words, such as "State: Issued" or "Search: Acme". */
export function describeCondition(catalog: AskCatalog, condition: AskCondition): string {
  const field = catalog.fields.find((f) => f.name === condition.field);
  if (!field) return `${condition.field}: ${condition.value}`;
  const value = field.values?.find((v) => v.value === condition.value)?.label ?? condition.value;
  return `${field.label}: ${value}`;
}
