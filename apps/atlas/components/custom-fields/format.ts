import type { createFormatter } from "next-intl";
import type { CustomField, CustomFieldValue } from "@/lib/custom-fields/types";
import { customFieldColumnKey } from "./columns";

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

/**
 * The display text of each row's values by column key (`cf.<key>`), null for none: what a list view carries
 * to its table (lib/custom-fields/server.ts).
 */
export function customFieldCells(
  fields: readonly CustomField[],
  values: ReadonlyMap<string, Readonly<Record<string, CustomFieldValue>>>,
  ids: readonly string[],
  c: CustomFieldFormatContext,
): Record<string, Record<string, string | null>> {
  return Object.fromEntries(
    ids.map((id) => {
      const row = values.get(id) ?? {};
      return [
        id,
        Object.fromEntries(
          fields.map((f) => {
            const value = row[f.key];
            return [
              customFieldColumnKey(f.key),
              value ? formatCustomFieldValue(f, value, c) : null,
            ];
          }),
        ),
      ];
    }),
  );
}
