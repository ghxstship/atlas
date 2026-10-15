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
import type { ReactNode } from "react";
import { useCopy } from "./use-copy";
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

export function PeekTable({
  columns,
  rows,
  caption,
}: {
  columns: DataTableColumn[];
  rows: (Record<string, unknown> & { id: string })[];
  caption: string;
}) {
  const router = useRouter();
  const href = useQueryHref();
  return (
    <DataTable
      columns={columns}
      rows={rows}
      caption={caption}
      onRowActivate={(row) => router.push(href({ peek: String(row["id"]), full: null }))}
    />
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
      onOpenChange={(open) => {
        if (!open) router.replace(href({ peek: null, full: null }));
      }}
      {...(full
        ? {
            footer: (
              <Button variant="primary" onClick={() => router.push(href({ full: "1" }))}>
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
