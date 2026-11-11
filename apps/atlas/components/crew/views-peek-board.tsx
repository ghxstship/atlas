"use client";

import { Board, type RecordState } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useRowMenu } from "@/components/menus/use-row-menu";
import { useQueryHref } from "./views.shared";

/**
 * A board by state whose cards open the side peek. Cards move only through transitions. A card's
 * menu (right-click, Shift+F10) offers what its table row's does: Open, Open full page, Copy link.
 */
export function PeekBoard(props: {
  columns: Array<{
    state: RecordState;
    label: string;
    cards: Array<{ key: string; title: string; meta?: string; owner?: string; due?: string }>;
  }>;
}) {
  const router = useRouter();
  const href = useQueryHref();
  const rowMenu = useRowMenu();
  const titles = new Map(
    props.columns.flatMap((c) => c.cards.map((card) => [card.key, card.title])),
  );
  return (
    <>
      <Board
        readOnly
        columns={props.columns}
        onOpen={(key) => router.push(href({ peek: key, full: null }))}
        onItemContextMenu={(key, at, element) =>
          rowMenu.open(
            {
              id: key,
              label: titles.get(key) ?? key,
              open: () => router.push(href({ peek: key, full: null })),
              href: href({ peek: key, full: "1" }),
            },
            at,
            element,
          )
        }
      />
      {rowMenu.menu}
    </>
  );
}
