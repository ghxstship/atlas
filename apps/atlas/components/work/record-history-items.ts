import type { Json } from "@xos/data/database.types";
import {
  ATTRIBUTE_FIELD_PREFIX,
  attributeColumn,
  eventCurrencies,
  type HistoryEvent,
} from "@xos/data/field-history";
import type { ExtensionValues } from "@xos/data/work";
import type { HistoryItem } from "@/components/history/field-history-list";
import { historyItems } from "@/lib/history/items";
import { formatMoney } from "./format";
import type { KindField } from "./record-panels";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Labels of the record fields its field history shows; keys, the kind, numbering and bookkeeping
 * columns are left out, and Trash is worded on its own.
 */
const RECORD_FIELD_LABELS: Readonly<Record<string, string>> = {
  title: "work.fields.title",
  record_subtype: "work.fields.subtype",
  record_state: "work.columns.state",
  phase_code: "work.fields.phase",
  urid: "work.fields.urid",
  xyz: "work.fields.xyz",
  owner_party_id: "work.fields.owner",
  accountable_party_id: "work.fields.accountable",
  scope_node_id: "work.fields.scope",
  starts_at: "work.fields.starts",
  ends_at: "work.fields.ends",
  due_at: "work.fields.due",
  time_zone: "work.fields.timeZone",
  blocker_text: "work.record.blockedBy",
  replan_reason: "work.fields.replanReason",
};

export interface RecordHistoryWording {
  readonly t: Translate;
  readonly locale: string;
  /** An instant in the record's schedule format. */
  readonly when: (iso: string) => string;
  /** When an event happened, in the viewer's format. */
  readonly at: (iso: string) => string;
  readonly number: (value: number) => string;
  /** A calendar day (YYYY-MM-DD), in the viewer's format. */
  readonly day: (value: string) => string;
  /** Person id to name. */
  readonly names: Readonly<Record<string, string>>;
  readonly phases: readonly { readonly value: string; readonly label: string }[];
  /** The kind's attributes (its extension row's fields), their current values and the currencies. */
  readonly fields: readonly KindField[];
  readonly extension: ExtensionValues;
  readonly currencies: readonly { readonly code: string; readonly exponent: number }[];
}

/**
 * A record's field history worded for the DiffViewer (Section 4.10), on its page, its work peek and
 * the shell's peek: the record's own fields by their form labels, and the kind's attributes
 * (`attributes.<column>`, A131) by `work.extension.<column>`, each value as its form shows it. An
 * amount reads in the currency its extension row held at that event (ADR 0090), and as so many
 * minor units when that currency is unknown.
 */
export function recordHistoryItems(
  events: readonly HistoryEvent[],
  w: RecordHistoryWording,
): HistoryItem[] {
  const { t } = w;
  const attributes = new Map(w.fields.map((f) => [f.column, f]));
  const person = (id: string) => w.names[id] ?? t("work.values.unnamed");
  // Each currency column's value at every event, walked back from the extension row's value now.
  const currencyAt = new Map(
    [...new Set(w.fields.flatMap((f) => (f.currencyColumn ? [f.currencyColumn] : [])))].map(
      (column) => {
        const now = w.extension[column];
        return [
          column,
          eventCurrencies(
            events,
            typeof now === "string" ? now : null,
            `${ATTRIBUTE_FIELD_PREFIX}${column}`,
          ),
        ];
      },
    ),
  );
  const attributeValue = (
    f: KindField,
    v: Json,
    at: { readonly event: HistoryEvent; readonly side: "before" | "after" },
  ): string => {
    const text = typeof v === "string" ? v : JSON.stringify(v);
    switch (f.type) {
      case "boolean":
        return t(v === true ? "collab.history.yes" : "collab.history.no");
      case "datetime":
        return w.when(text);
      case "date":
        return w.day(text);
      case "person":
        return person(text);
      case "select":
        return f.options?.find((o) => o.value === text)?.label ?? text;
      case "number":
        return typeof v === "number" ? w.number(v) : text;
      case "money": {
        if (typeof v !== "number") return text;
        const code = f.currencyColumn
          ? (currencyAt.get(f.currencyColumn)?.get(at.event.id)?.[at.side] ?? null)
          : null;
        const currency = w.currencies.find((c) => c.code === code);
        const formatted = currency
          ? formatMoney(v, currency.code, w.locale, currency.exponent)
          : null;
        return formatted ?? t("collab.history.minorUnits", { amount: w.number(v) });
      }
      default:
        return text.length > 160 ? `${text.slice(0, 157)}...` : text;
    }
  };
  return historyItems(events, {
    t,
    when: w.at,
    label: (field) => {
      const attribute = attributeColumn(field);
      if (attribute !== null) {
        return attributes.has(attribute) ? t(`work.extension.${attribute}`) : null;
      }
      const key = RECORD_FIELD_LABELS[field];
      return field === "deleted_at" ? t("collab.history.trash") : key ? t(key) : null;
    },
    value: (field, v, at) => {
      const attribute = attributeColumn(field);
      const kindField = attribute === null ? undefined : attributes.get(attribute);
      if (kindField) return attributeValue(kindField, v, at);
      const text = typeof v === "string" ? v : JSON.stringify(v);
      if (field === "owner_party_id" || field === "accountable_party_id") return person(text);
      if (field === "record_state") return t(`work.states.${text}`);
      if (field === "phase_code") return w.phases.find((p) => p.value === text)?.label ?? text;
      if (field === "deleted_at") return w.when(text);
      if (field === "starts_at" || field === "ends_at" || field === "due_at") return w.when(text);
      return text;
    },
  });
}
