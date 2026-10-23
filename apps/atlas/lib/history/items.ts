import type { Json } from "@xos/data/database.types";
import type { HistoryEvent } from "@xos/data/field-history";
import type { HistoryItem } from "@/components/history/field-history-list";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Field history events worded for the DiffViewer (Section 4.10): who did what and when, and each
 * visible field before and after. `label` names a field or returns null to leave it out (keys and
 * bookkeeping); `value` formats a stored value. A masked field reads Restricted; an empty one Not set.
 * An edit that touched only hidden fields is left out.
 */
export function historyItems(
  events: readonly HistoryEvent[],
  input: {
    readonly t: Translate;
    readonly label: (field: string) => string | null;
    readonly value: (field: string, value: Json) => string;
    readonly when: (iso: string) => string;
  },
): HistoryItem[] {
  const { t } = input;
  const show = (field: string, v: Json | null, masked: boolean) =>
    masked
      ? t("collab.history.masked")
      : v === null || v === ""
        ? t("collab.history.notSet")
        : input.value(field, v);
  return events.flatMap((event): HistoryItem[] => {
    const name = event.actorName ?? t("collab.history.someone");
    const when = input.when(event.at);
    if (event.operation !== "update") {
      const key =
        event.operation === "insert" ? "collab.history.created" : "collab.history.deleted";
      return [{ id: event.id, heading: t(key, { name }), when, rows: [] }];
    }
    const rows = event.changes.flatMap((c) => {
      const field = input.label(c.field);
      return field === null
        ? []
        : [
            {
              field,
              before: show(c.field, c.before, c.masked),
              after: show(c.field, c.after, c.masked),
            },
          ];
    });
    if (rows.length === 0) return [];
    return [
      {
        id: event.id,
        heading: t("collab.history.changed", { name, count: rows.length }),
        when,
        rows,
      },
    ];
  });
}
