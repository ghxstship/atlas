"use client";

import {
  Board,
  Button,
  DataTable,
  Drawer,
  PropertyList,
  Select,
  StateChip,
  type DataTableColumn,
  type RecordState,
} from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, type ReactNode } from "react";
import { useCopy } from "./use-copy";
import type { BulkConfig } from "@/components/bulk/types";
import { useBulk } from "@/components/bulk/use-bulk";
import { useRowMenu } from "@/components/menus/use-row-menu";
import { CollectionViews } from "@/components/views/collection-views";

/**
 * Client pieces of the Advancing collection pages. Every view keeps its state in the query string
 * (Section 4.5.3): `view`, `project`, `filter`, and `peek` with `full=1` for a row's full page, so
 * switching views keeps the filter and a peek link can be shared.
 */

/** A copy of the current query string with some keys set or removed. */
export function useQueryHref() {
  const pathname = usePathname();
  const search = useSearchParams();
  return (changes: Readonly<Record<string, string | null>>): Route => {
    const next = new URLSearchParams(search.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    return (query ? `${pathname}?${query}` : pathname) as Route;
  };
}

export function ViewSwitcher({ views, current }: { views: readonly string[]; current: string }) {
  const t = useCopy("advancing.views");
  const router = useRouter();
  const href = useQueryHref();
  if (views.length < 2) return null;
  return (
    <CollectionViews
      label={t("label")}
      value={current}
      options={views.map((v) => ({ value: v, label: t(v) }))}
      onChange={(v) => router.replace(href({ view: v }))}
    />
  );
}

export function SelectFilter({
  id,
  label,
  value,
  options,
  param,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  param: string;
}) {
  const router = useRouter();
  const href = useQueryHref();
  return (
    <Select
      id={id}
      label={label}
      value={value}
      options={[...options]}
      onChange={(e) =>
        router.replace(href({ [param]: e.target.value === "" ? null : e.target.value, peek: null }))
      }
    />
  );
}

export interface BoardColumn {
  readonly state: RecordState;
  readonly label: string;
  readonly cards: readonly { key: string; title: string; meta?: string; due?: string }[];
}

/** A read-only board: columns are derived states, so cards open but never move. */
export function PeekBoard({ columns }: { columns: readonly BoardColumn[] }) {
  const router = useRouter();
  const href = useQueryHref();
  return (
    <Board
      readOnly
      columns={columns.map((c) => ({ ...c, cards: [...c.cards] }))}
      onOpen={(key) => router.push(href({ peek: key, full: null }))}
    />
  );
}

/**
 * The table view: Enter or a double click opens a row's peek. Right-click, Shift+F10 or the Context
 * Menu key opens the row's menu; with `bulk`, rows select by click, Cmd or Ctrl+click, Shift+click, X
 * and Cmd or Ctrl+A, and the bulk bar changes a property across the selection (Section 11.7).
 */
export function PeekTable({
  columns,
  rows,
  caption,
  bulk,
  full = true,
}: {
  columns: DataTableColumn[];
  /** Each row names itself in `label` for its menu and bulk refusals; the first column otherwise. */
  rows: (Record<string, unknown> & { id: string; label?: string })[];
  caption: string;
  bulk?: BulkConfig | null;
  /** False for rows without a full page, such as guests. */
  full?: boolean;
}) {
  const router = useRouter();
  const href = useQueryHref();
  const nameOf = useCallback(
    (row: Record<string, unknown>) => {
      const named = row["label"] ?? row[columns[0]?.key ?? "id"];
      return typeof named === "string" || typeof named === "number"
        ? String(named)
        : String(row["id"]);
    },
    [columns],
  );
  const refs = useMemo(() => rows.map((r) => ({ id: r.id, label: nameOf(r) })), [rows, nameOf]);
  const selection = useBulk(bulk, refs);
  const rowMenu = useRowMenu();
  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        caption={caption}
        onRowActivate={(row) => router.push(href({ peek: String(row["id"]), full: null }))}
        onRowContextMenu={(row, _index, at, cell) => {
          const id = String(row["id"]);
          rowMenu.open(
            {
              id,
              label: nameOf(row),
              open: () => router.push(href({ peek: id, full: null })),
              ...(full ? { href: href({ peek: id, full: "1" }) } : {}),
              bulk: selection,
            },
            at,
            cell,
          );
        }}
        {...(selection.selection ? { selection: selection.selection } : {})}
      />
      {selection.bar}
      {rowMenu.menu}
    </>
  );
}

/**
 * The side peek of a row that is not one of the 26 record kinds (packets, riders, reconciliation
 * runs): title, derived state and properties, with Open full page. Closing it drops `peek`.
 */
export function PeekPanel({
  title,
  state,
  stateLabel,
  properties,
  children,
  full = true,
}: {
  title: string;
  state: RecordState;
  stateLabel: string;
  properties: { label: string; value: ReactNode }[];
  children?: ReactNode;
  /** False for rows without a full page, such as guests. */
  full?: boolean;
}) {
  const t = useCopy("advancing.common");
  const router = useRouter();
  const href = useQueryHref();
  return (
    <Drawer
      open
      title={title}
      shortcutScope="record"
      onOpenChange={(open) => {
        if (!open) router.replace(href({ peek: null, full: null }));
      }}
      {...(full
        ? {
            footer: (
              <Button
                variant="primary"
                data-shortcut="record.open"
                onClick={() => router.push(href({ full: "1" }))}
              >
                {t("openFull")}
              </Button>
            ),
          }
        : {})}
    >
      <div>
        <StateChip state={state} label={stateLabel} />
      </div>
      <PropertyList items={properties} />
      {children}
    </Drawer>
  );
}
