"use client";

import { Board } from "@xos/ui";
import { useQueryNav } from "./kit-use-query-nav";
import { type BoardColumn } from "./kit.types";

/**
 * The board view by state. Cards open their peek; moving between states happens through the
 * lifecycle actions, which carry the reason and the spend checks a drag cannot.
 */
export function CollectionBoard({ columns }: { columns: readonly BoardColumn[] }) {
  const go = useQueryNav();
  return (
    <Board
      readOnly
      columns={columns.map((c) => ({ ...c, cards: [...c.cards] }))}
      onOpen={(key) => go({ peek: key })}
    />
  );
}
