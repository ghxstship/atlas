import type { Json } from "@xos/data/database.types";
import { isMinorField } from "@xos/data/field-history";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * How a record page words the fields of its history when it has no labels of its own (A131,
 * ADR 0090): each column by its header in the shared column dictionary (`views.export.columns`,
 * the export headers), each value by the shape of its column. Keys, references to other rows and
 * people, display keys and hashes are left out: their before and after would be ids, not
 * something a person changed.
 */

const HIDDEN = new Set([
  "id",
  "org_id",
  "record_kind",
  "created_at",
  "updated_at",
  "search_vector",
]);
const HIDDEN_SUFFIX = /(_id|_ids|_by|_display_key|_sha256|_hash)$/;

/** Whether a history field stays out of a record page's history. */
export function isHiddenHistoryField(field: string): boolean {
  return HIDDEN.has(field) || HIDDEN_SUFFIX.test(field);
}

/**
 * The catalog key that labels a history field, or null when the field is left out. An amount is
 * labeled on its own (`collab.history.money`): the export headers say "(minor units)", and a
 * history shows the amount in its currency.
 */
export function historyLabelKey(field: string): string | null {
  if (field === "deleted_at") return "collab.history.trash";
  if (isHiddenHistoryField(field)) return null;
  if (isMinorField(field)) return `collab.history.money.${field}`;
  return `views.export.columns.${field}`;
}

export interface HistoryFormat {
  readonly t: Translate;
  /** An instant, in the viewer's format. */
  readonly dateTime: (iso: string) => string;
  /** A calendar day (YYYY-MM-DD), in the viewer's format. */
  readonly date: (day: string) => string;
  readonly number: (value: number, fractionDigits?: number) => string;
  /** An amount in minor units in its currency (ISO 4217 code and minor unit exponent). */
  readonly money: (minor: number, currencyCode: string, exponent: number) => string;
}

/** The currency an amount of a history is in, with its minor unit exponent; null when unknown. */
export type HistoryCurrency = { readonly code: string; readonly exponent: number } | null;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
/** Long text shows its opening; the page shows the whole current value. */
const MAX_TEXT = 160;

/**
 * A stored value worded for the DiffViewer: yes or no, a day or an instant, a number, an amount in
 * its currency (`currency`, the row's at that event, with its exponent: 80000 USD is $800.00, 500
 * JPY is ¥500), and text shortened past 160 characters. An amount whose currency is unknown reads
 * as so many minor units, never as a guessed major amount.
 */
export function historyValue(
  field: string,
  value: Json,
  format: HistoryFormat,
  currency: HistoryCurrency = null,
): string {
  if (typeof value === "boolean") {
    return format.t(value ? "collab.history.yes" : "collab.history.no");
  }
  if (typeof value === "number") {
    if (!isMinorField(field)) return format.number(value);
    return currency
      ? format.money(value, currency.code, currency.exponent)
      : format.t("collab.history.minorUnits", { amount: format.number(value) });
  }
  if (typeof value === "string") {
    if (field === "deleted_at" || (field.endsWith("_at") && INSTANT.test(value))) {
      return format.dateTime(value);
    }
    if (DAY.test(value)) return format.date(value);
    return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 3)}...` : value;
  }
  const text = JSON.stringify(value);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 3)}...` : text;
}
