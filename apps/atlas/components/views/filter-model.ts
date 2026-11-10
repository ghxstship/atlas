import { operatorsFor } from "@xos/data/custom-fields";
import type { CustomFieldListView } from "@/lib/custom-fields/types";
import { FIELD_OPERATORS, type Condition, type ConditionOperator } from "@/lib/views/conditions";

/**
 * What the Add filter control offers (A117): the page's declared fields (its columns) and the org's filterable
 * custom fields of the page's table, each with the conditions its kind takes, and the mapping between the
 * choices a person makes and the URL conditions of lib/views/conditions.ts.
 */

/** A field the page declares: a column key, its label and, when few, the values it shows. */
export interface FilterField {
  readonly key: string;
  readonly label: string;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

export type FilterKind =
  "text" | "number" | "money" | "date" | "timestamp" | "boolean" | "choice" | "person";

export interface FilterTarget {
  readonly scope: Condition["scope"];
  readonly key: string;
  readonly label: string;
  readonly kind: FilterKind;
  /** Values to pick from (choices, people, a column's values); free entry when absent. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly operators: readonly ConditionOperator[];
}

/** A condition as the editor offers it: the operator, with is_null split into is empty and has a value. */
export type FilterChoice = Exclude<ConditionOperator, "is_null"> | "empty" | "filled";

const KIND: Readonly<Record<string, FilterKind>> = {
  Text: "text",
  Email: "text",
  URL: "text",
  Number: "number",
  Money: "money",
  Date: "date",
  Timestamp: "timestamp",
  Boolean: "boolean",
  Choice: "choice",
  Person: "person",
};

/** Every field the control offers: the page's declared fields, then the org's filterable custom fields. */
export function filterTargets(
  fields: readonly FilterField[],
  custom: CustomFieldListView | null,
  labels: { readonly yes: string; readonly no: string },
): FilterTarget[] {
  const declared: FilterTarget[] = fields.map((f) => ({
    scope: "field",
    key: f.key,
    label: f.label,
    kind: "text",
    ...(f.options && f.options.length > 0 ? { options: f.options } : {}),
    operators: FIELD_OPERATORS,
  }));
  const people = Object.entries(custom?.people ?? {})
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const own: FilterTarget[] = (custom?.fields ?? [])
    .filter((f) => f.filterable)
    .map((f) => {
      const kind = KIND[f.dataType] ?? "text";
      const options =
        kind === "choice"
          ? f.choices.map((c) => ({ value: c.key, label: c.label }))
          : kind === "person"
            ? people
            : kind === "boolean"
              ? [
                  { value: "true", label: labels.yes },
                  { value: "false", label: labels.no },
                ]
              : undefined;
      return {
        scope: "custom" as const,
        key: f.key,
        label: f.label,
        kind,
        ...(options ? { options } : {}),
        operators: operatorsFor(f.dataType),
      };
    });
  return [...declared, ...own];
}

/** The choices a target offers, in order: its operators with is_null as is empty and has a value. */
export function choicesFor(target: FilterTarget): FilterChoice[] {
  return target.operators.flatMap((op): FilterChoice[] =>
    op === "is_null" ? ["empty", "filled"] : [op],
  );
}

/** True when the choice needs no value. */
export function needsValue(choice: FilterChoice): boolean {
  return choice !== "empty" && choice !== "filled";
}

export function toCondition(target: FilterTarget, choice: FilterChoice, value: string): Condition {
  if (choice === "empty" || choice === "filled") {
    return {
      scope: target.scope,
      key: target.key,
      operator: "is_null",
      value: choice === "empty" ? "true" : "false",
    };
  }
  return { scope: target.scope, key: target.key, operator: choice, value: value.trim() };
}

export function choiceOf(condition: Condition): FilterChoice {
  if (condition.operator === "is_null") return condition.value === "false" ? "filled" : "empty";
  return condition.operator;
}

/** The catalog key (under `views.filter.ops`) of a choice's words for a kind of field. */
export function choiceLabelKey(kind: FilterKind, choice: FilterChoice): string {
  const dated = kind === "date" || kind === "timestamp";
  switch (choice) {
    case "eq":
      return dated ? "on" : "is";
    case "ne":
      return "isNot";
    case "gt":
      return dated ? "after" : "moreThan";
    case "gte":
      return dated ? "onOrAfter" : "atLeast";
    case "lt":
      return dated ? "before" : "lessThan";
    case "lte":
      return dated ? "onOrBefore" : "atMost";
    default:
      return choice;
  }
}
