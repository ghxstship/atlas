"use client";

import { RecordList, RecordRow } from "@xos/ui";
import { useMemo } from "react";
import type { BulkConfig } from "@/components/bulk/types";
import { useFinanceT } from "./kit-use-finance-t";
import { useItemActions } from "./kit-use-item-actions";
import { useQueryNav } from "./kit-use-query-nav";
import { type ListItem } from "./kit.types";

/**
 * The list view: rows answer what now, and Enter or a click opens the peek (Section 11.10 rule 4).
 * Rows select, open their menu and preview their key or title as the table's rows do (Section
 * 11.7). On a page with no record panel (`activatable={false}`) rows open nothing and offer no Open.
 */
export function CollectionList({
  label,
  items,
  bulk,
  activatable = true,
}: {
  label: string;
  items: readonly ListItem[];
  /** Bulk edit of a selection (Section 11.7). */
  bulk?: BulkConfig | null;
  /** False on a page with no record panel for its rows, such as Year-end. */
  activatable?: boolean;
}) {
  const go = useQueryNav();
  const t = useFinanceT();
  const refs = useMemo(() => items.map((i) => ({ id: i.id, label: i.recordKey })), [items]);
  const actions = useItemActions({
    refs,
    previews: items,
    columns: ["key", "title"],
    bulk,
    activatable,
  });
  const { selection } = actions.bulk;
  return (
    <div {...actions.hoverProps}>
      <RecordList
        label={label}
        onItemContextMenu={actions.menuFor}
        {...(selection ? { selection } : {})}
      >
        {items.map((item) => (
          <RecordRow
            key={item.id}
            id={item.id}
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
      {actions.after}
    </div>
  );
}
