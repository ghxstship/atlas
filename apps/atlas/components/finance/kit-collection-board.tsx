"use client";

import { Board } from "@xos/ui";
import { useQueryNav } from "./kit-use-query-nav";
import { type BoardColumn } from "./kit.types";

/**
 * The board view by state. Cards open their peek, except on a page with no record panel
 * (`activatable={false}`); moving between states happens through the lifecycle actions, which
 * carry the reason and the spend checks a drag cannot.
 */
export function CollectionBoard({
  columns,
  activatable = true,
}: {
  columns: readonly BoardColumn[];
  /** False on a page with no record panel for its cards. */
  activatable?: boolean;
}) {
  const go = useQueryNav();
  return (
    <Board
      readOnly
      columns={columns.map((c) => ({ ...c, cards: [...c.cards] }))}
      {...(activatable ? { onOpen: (key: string) => go({ peek: key }) } : {})}
    />
  );
}
