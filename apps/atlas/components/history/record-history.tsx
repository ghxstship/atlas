import type { XosClient } from "@xos/data";
import {
  eventCurrencies,
  getFieldHistory,
  getHistoryMoney,
  hasFieldHistory,
  isMinorField,
} from "@xos/data/field-history";
import { getFormatter, getTranslations } from "next-intl/server";
import { historyLabelKey, historyValue } from "@/lib/history/fields";
import { historyItems } from "@/lib/history/items";
import { LazyFieldHistoryList } from "./lazy-field-history-list";

/**
 * A record's field history on its page or peek (Section 4.10, A131): who changed which field,
 * when, from what to what, on the DiffViewer. Renders nothing for a table without a field history
 * (private.field_history_subjects), so the shared comment and file sections can carry it for every
 * record they serve. Fields are labeled from the shared column dictionary (lib/history/fields.ts);
 * a field it does not label is left out. An amount reads in the currency the row held at that event
 * (app.currencies gives its exponent). Only someone who can read the row gets its history, and a
 * Restricted field reads Restricted.
 */
export async function RecordHistory({
  db,
  table,
  id,
}: {
  db: XosClient;
  table: string;
  id: string;
}) {
  if (!hasFieldHistory(table)) return null;
  const [history, tr, format] = await Promise.all([
    getFieldHistory(db, table, id),
    getTranslations(),
    getFormatter(),
  ]);
  // Keys are computed from column names, so the typed key union is widened here.
  const t = (key: string, values?: Record<string, string | number>) =>
    (tr as unknown as (k: string, v?: Record<string, string | number>) => string)(key, values);
  const has = (key: string) => (tr as unknown as { has: (k: string) => boolean }).has(key);
  const hasAmounts =
    history.ok && history.data.some((e) => e.changes.some((c) => isMinorField(c.field)));
  const money = hasAmounts ? await getHistoryMoney(db, table, id) : null;
  if (!history.ok || (money !== null && !money.ok)) {
    return (
      <p className="m-0 text-text-13 text-text-secondary">{t("collab.history.unavailable")}</p>
    );
  }
  const currencies = money?.ok
    ? money.data
    : { currencyCode: null, exponents: new Map<string, number>() };
  const byEvent = eventCurrencies(history.data, currencies.currencyCode);
  const currencyOf = (eventId: string, side: "before" | "after") => {
    const code = byEvent.get(eventId)?.[side] ?? null;
    const exponent = code === null ? undefined : currencies.exponents.get(code);
    return code === null || exponent === undefined ? null : { code, exponent };
  };
  const dateTime = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  return (
    <LazyFieldHistoryList
      id={id}
      title={t("collab.history.title")}
      empty={t("collab.history.empty")}
      items={historyItems(history.data, {
        t,
        when: dateTime,
        label: (field) => {
          const key = historyLabelKey(field);
          return key !== null && has(key) ? t(key) : null;
        },
        value: (field, v, at) =>
          historyValue(
            field,
            v,
            {
              t,
              dateTime,
              date: (day) =>
                format.dateTime(new Date(`${day}T00:00:00Z`), {
                  dateStyle: "medium",
                  timeZone: "UTC",
                }),
              number: (n, digits) =>
                format.number(
                  n,
                  digits === undefined
                    ? undefined
                    : { minimumFractionDigits: digits, maximumFractionDigits: digits },
                ),
              money: (minor, currency, exponent) =>
                format.number(minor / 10 ** exponent, {
                  style: "currency",
                  currency,
                  minimumFractionDigits: exponent,
                  maximumFractionDigits: exponent,
                }),
            },
            currencyOf(at.event.id, at.side),
          ),
      })}
    />
  );
}
