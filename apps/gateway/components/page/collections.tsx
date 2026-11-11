"use client";

import { Board, DataTable, type DataTableColumn, type RecordState } from "@xos/ui";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { useBulk, type BulkRowRef } from "@/components/bulk/use-bulk";
import { useRowMenu } from "@/components/menus/use-row-menu";
import type { GatewayActionId } from "@/lib/bulk/catalog";

/**
 * Collection views (Section 11.15) whose rows open a page. Server pages pass plain data; these
 * client wrappers turn a row's `href` into navigation, so a board card or a table row opens its
 * record by keyboard (Enter) or pointer. A table's rows also select and take the list's action in
 * bulk, and open a menu of their actions (Section 11.7, ADR 0082).
 */

export interface BoardColumn {
  readonly state: RecordState;
  readonly label: string;
  readonly cards: readonly {
    readonly key: string;
    readonly title: string;
    readonly meta?: string;
    readonly href: string;
  }[];
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
        cards: c.cards.map((card) => ({
          key: card.key,
          title: card.title,
          ...(card.meta ? { meta: card.meta } : {}),
        })),
      }))}
      onOpen={(key) => {
        const href = hrefs.get(key);
        if (href) router.push(href as Route);
      }}
    />
  );
}

/** The text of a row's first column, the name its menu and checkbox use when it has no label. */
function rowName(row: Record<string, unknown>, columns: readonly DataTableColumn[]): string {
  const label = row["label"];
  if (typeof label === "string" && label !== "") return label;
  const first = columns[0] ? row[columns[0].key] : undefined;
  return typeof first === "string" ? first : "";
}

/**
 * A table whose rows open their `href` (Enter on a cell, or a double click). Rows that carry an
 * `id` open a menu of their actions by right-click, Shift+F10 or the Context Menu key. With an
 * `action`, rows select (click, Shift, Cmd or Ctrl, X, Cmd or Ctrl+A) and the bulk bar takes the
 * action on the selected rows whose `eligible` is true.
 */
export function LinkTable({
  columns,
  rows,
  caption,
  action,
}: {
  columns: DataTableColumn[];
  rows: Record<string, unknown>[];
  caption: string;
  action?: GatewayActionId;
}) {
  const router = useRouter();
  const refs = useMemo<BulkRowRef[]>(
    () =>
      rows.flatMap((row) =>
        typeof row["id"] === "string"
          ? [{ id: row["id"], label: rowName(row, columns), eligible: row["eligible"] === true }]
          : [],
      ),
    [rows, columns],
  );
  const bulk = useBulk(action ?? null, refs);
  const menu = useRowMenu();
  const menus = refs.length > 0 && (bulk.selection !== undefined || rows.some((r) => r["href"]));
  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        caption={caption}
        density="comfortable"
        rowId={(row, index) => (typeof row["id"] === "string" ? row["id"] : String(index))}
        {...(bulk.selection ? { selection: bulk.selection } : {})}
        {...(menus
          ? {
              onRowContextMenu: (
                row: Record<string, unknown>,
                _index: number,
                at: { x: number; y: number } | null,
                cell: HTMLElement,
              ) => {
                const id = row["id"];
                if (typeof id !== "string") return;
                const href = row["href"];
                menu.open(
                  {
                    id,
                    label: rowName(row, columns),
                    ...(typeof href === "string" ? { href } : {}),
                    bulk,
                    eligible: row["eligible"] === true,
                  },
                  at,
                  cell,
                );
              },
            }
          : {})}
        onRowActivate={(row) => {
          const href = row["href"];
          if (typeof href === "string") router.push(href as Route);
        }}
      />
      {bulk.bar}
      {menu.menu}
    </>
  );
}
