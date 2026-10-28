"use client";

import { Board } from "@xos/ui";
import { useMemo } from "react";
import type { BulkConfig } from "@/components/bulk/types";
import { useItemActions } from "./kit-use-item-actions";
import { useQueryNav } from "./kit-use-query-nav";
import { type BoardColumn, type ListItem } from "./kit.types";

/**
 * The board view by state. Cards open their peek, except on a page with no record panel
 * (`activatable={false}`); moving between states happens through the lifecycle actions, which
 * carry the reason and the spend checks a drag cannot. Cards select, open their menu and preview
 * their key or title as the table's rows do (Section 11.7).
 */
export function CollectionBoard({
  columns,
  previews,
  bulk,
  activatable = true,
}: {
  columns: readonly BoardColumn[];
  /** The cards as list items, by the card key, for their hover cards. */
  previews?: readonly ListItem[];
  /** Bulk edit of a selection (Section 11.7). */
  bulk?: BulkConfig | null;
  /** False on a page with no record panel for its cards. */
  activatable?: boolean;
}) {
  const go = useQueryNav();
  // A card names itself by its list item's key where the page has one, as its table row does.
  const refs = useMemo(() => {
    const keys = new Map((previews ?? []).map((p) => [p.id, p.recordKey]));
    return columns.flatMap((c) =>
      c.cards.map((card) => ({ id: card.key, label: keys.get(card.key) ?? card.title })),
    );
  }, [columns, previews]);
  const actions = useItemActions({
    refs,
    previews,
    columns: ["key", "title"],
    bulk,
    activatable,
  });
  const { selection } = actions.bulk;
  return (
    <div {...actions.hoverProps}>
      <Board
        readOnly
        columns={columns.map((c) => ({ ...c, cards: [...c.cards] }))}
        onItemContextMenu={actions.menuFor}
        {...(selection ? { selection } : {})}
        {...(activatable ? { onOpen: (key: string) => go({ peek: key }) } : {})}
      />
      {actions.after}
    </div>
  );
}
