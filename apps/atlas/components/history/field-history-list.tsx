"use client";

import { DiffViewer } from "@xos/ui";

/** One event of a field history, already worded and formatted on the server. */
export interface HistoryItem {
  readonly id: string;
  /** "Dave Lindqvist changed 2 fields". */
  readonly heading: string;
  /** When, in the viewer's format. */
  readonly when: string;
  readonly rows: readonly { field: string; before: string; after: string }[];
}

/**
 * A record's field history (Section 4.10) on the DiffViewer: each change with who made it and when,
 * its fields before and after, struck through and underlined so change never relies on color.
 */
export function FieldHistoryList({
  id,
  title,
  items,
  empty,
}: {
  id: string;
  title: string;
  items: readonly HistoryItem[];
  empty: string;
}) {
  return (
    <section aria-labelledby={`field-history-${id}`} className="flex flex-col gap-8">
      <h3 id={`field-history-${id}`} className="m-0 text-label-13 font-semibold">
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{empty}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-12 p-0">
          {items.map((item) => (
            <li key={item.id} className="flex flex-col gap-4">
              {item.rows.length > 0 ? (
                // The caption names the change: who and when.
                <DiffViewer caption={`${item.heading} · ${item.when}`} rows={[...item.rows]} />
              ) : (
                <p className="m-0 text-text-13">
                  <span className="font-medium">{item.heading}</span>{" "}
                  <span className="text-text-secondary">{item.when}</span>
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
