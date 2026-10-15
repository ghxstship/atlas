"use client";

import { Board, DataTable, type DataTableColumn, type RecordState } from "@xos/ui";
import type { Route } from "next";
import { useRouter } from "next/navigation";

/**
 * Collection views (Section 11.15) whose rows open a page. Server pages pass plain data; these
 * client wrappers turn a row's `href` into navigation, so a board card or a table row opens its
 * record by keyboard (Enter) or pointer.
 */

export interface BoardColumn {
  readonly state: RecordState;
  readonly label: string;
  readonly cards: readonly { readonly key: string; readonly title: string; readonly meta?: string; readonly href: string }[];
}

/** A read-only board: the person cannot move their own records between states. */
export function LinkBoard({ columns }: { columns: readonly BoardColumn[] }) {
  const router = useRouter();
  const hrefs = new Map(columns.flatMap((c) => c.cards.map((card) => [card.key, card.href])));
  return (
    <Board
      readOnly
      columns={columns.map((c) => ({
        state: c.state,
        label: c.label,
        cards: c.cards.map((card) => ({ key: card.key, title: card.title, ...(card.meta ? { meta: card.meta } : {}) })),
      }))}
      onOpen={(key) => {
        const href = hrefs.get(key);
        if (href) router.push(href as Route);
      }}
    />
  );
}

/** A table whose rows open their `href` (Enter on a cell, or a double click). */
export function LinkTable({
  columns,
  rows,
  caption,
}: {
  columns: DataTableColumn[];
  rows: Record<string, unknown>[];
  caption: string;
}) {
  const router = useRouter();
  return (
    <DataTable
      columns={columns}
      rows={rows}
      caption={caption}
      density="comfortable"
      onRowActivate={(row) => {
        const href = row["href"];
        if (typeof href === "string") router.push(href as Route);
      }}
    />
  );
}
