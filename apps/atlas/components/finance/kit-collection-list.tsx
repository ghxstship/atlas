"use client";

import { RecordList, RecordRow } from "@xos/ui";
import { useFinanceT } from "./kit-use-finance-t";
import { useQueryNav } from "./kit-use-query-nav";
import { type ListItem } from "./kit.types";

/**
 * The list view: rows answer what now, and Enter or a click opens the peek (Section 11.10 rule 4).
 * On a page with no record panel (`activatable={false}`) rows open nothing and offer no Open.
 */
export function CollectionList({
  label,
  items,
  activatable = true,
}: {
  label: string;
  items: readonly ListItem[];
  /** False on a page with no record panel for its rows, such as Year-end. */
  activatable?: boolean;
}) {
  const go = useQueryNav();
  const t = useFinanceT();
  return (
    <RecordList label={label}>
      {items.map((item) => (
        <RecordRow
          key={item.id}
          recordKey={item.recordKey}
          title={item.title}
          state={item.state}
          stateLabel={item.stateLabel}
          {...(item.next ? { next: item.next } : {})}
          {...(item.owner ? { owner: item.owner } : {})}
          {...(activatable
            ? {
                actionLabel: t("common.open"),
                onAction: () => go({ peek: item.id }),
                onOpen: () => go({ peek: item.id }),
              }
            : {})}
        />
      ))}
    </RecordList>
  );
}
