import type { createFormatter } from "next-intl";
import type { CustomField, CustomFieldListView, CustomFieldValue } from "@/lib/custom-fields/types";

/**
 * Custom field values as display text (A117), shared by server tables (getFormatter) and client ones
 * (useFormatter): dates in the medium style, timestamps in the org's zone, money in its own currency, choices
 * and people by name. The formatter is next-intl's, so the viewer's locale decides.
 */

/** next-intl's formatter, from useFormatter or getFormatter. */
export type CustomFieldFormatter = Pick<ReturnType<typeof createFormatter>, "dateTime" | "number">;

export interface CustomFieldFormatContext {
  readonly format: CustomFieldFormatter;
  /** Catalog text for true and false. */
  readonly yes: string;
  readonly no: string;
  /** Person id to name. */
  readonly people: Readonly<Record<string, string>>;
  /** What a person value shows when the person is not among the org's members any more. */
  readonly someone: string;
  readonly timeZone: string;
}

/** The minor unit exponent of a currency, as Intl knows it (ISO 4217); 2 when unknown. */
export function currencyExponent(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

export function formatCustomFieldValue(
  field: Pick<CustomField, "choices">,
  value: CustomFieldValue,
  c: CustomFieldFormatContext,
): string {
  switch (value.type) {
    case "Number":
      return c.format.number(value.number);
    case "Money": {
      const exponent = currencyExponent(value.currency);
      return c.format.number(value.minor / 10 ** exponent, {
        style: "currency",
        currency: value.currency,
        minimumFractionDigits: exponent,
        maximumFractionDigits: exponent,
      });
    }
    case "Date":
      return c.format.dateTime(new Date(`${value.date}T00:00:00Z`), {
        dateStyle: "medium",
        timeZone: "UTC",
      });
    case "Timestamp":
      return c.format.dateTime(new Date(value.at), {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: c.timeZone,
      });
    case "Boolean":
      return value.boolean ? c.yes : c.no;
    case "Choice":
      return field.choices.find((choice) => choice.id === value.choiceId)?.label ?? "";
    case "Person":
      return c.people[value.personId] ?? c.someone;
    default:
      return value.text;
  }
}

/** The column key of a custom field in a table: the filter's `cf.<key>`. */
export function customFieldColumnKey(key: string): string {
  return `cf.${key}`;
}

export interface CustomFieldColumns {
  /** The filterable fields as columns, after the page's own. */
  readonly columns: readonly { readonly key: string; readonly label: string }[];
  /** A row's cells for those columns: display text, or null for no value. */
  readonly cells: (id: string) => Record<string, string | null>;
}

export const NO_CUSTOM_FIELD_COLUMNS: CustomFieldColumns = { columns: [], cells: () => ({}) };

/** A list view's filterable fields as table columns and each row's cells. */
export function customFieldColumns(
  view: CustomFieldListView | null | undefined,
  c: Omit<CustomFieldFormatContext, "people" | "timeZone">,
): CustomFieldColumns {
  if (!view || view.fields.length === 0) return NO_CUSTOM_FIELD_COLUMNS;
  const context = { ...c, people: view.people, timeZone: view.timeZone };
  return {
    columns: view.fields.map((f) => ({ key: customFieldColumnKey(f.key), label: f.label })),
    cells: (id) => {
      const values = view.values[id] ?? {};
      return Object.fromEntries(
        view.fields.map((f) => {
          const value = values[f.key];
          return [
            customFieldColumnKey(f.key),
            value ? formatCustomFieldValue(f, value, context) : null,
          ];
        }),
      );
    },
  };
}
