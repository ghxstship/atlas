"use client";

import {
  Board,
  Calendar,
  DataTable,
  Drawer,
  TreeView,
  type BoardProps,
  type CalendarProps,
  type DataTableColumn,
  type TreeNode,
} from "@xos/ui";
import type { Route } from "next";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, type ReactNode } from "react";
import type { ViewType } from "./views";
import { CollectionViews } from "@/components/views/collection-views";
import { useCustomFieldColumns } from "@/components/custom-fields/list";

/**
 * Client pieces shared by the Places and Safety collections. Navigation state (view, peek, create,
 * full page) lives in the query string, so every one of these writes the URL rather than local
 * state: a reload, a shared link and the browser back button all land on the same screen.
 */

/** Sets or removes query keys on the current path, keeping the rest. */
export function useQueryNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  return useCallback(
    (changes: Readonly<Record<string, string | undefined>>, mode: "push" | "replace" = "push") => {
      const next = new URLSearchParams(search.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) next.delete(key);
        else next.set(key, value);
      }
      const query = next.toString();
      const href = (query ? `${pathname}?${query}` : pathname) as Route;
      if (mode === "replace") router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    },
    [router, pathname, search],
  );
}

/** The view switcher: only the views that fit the data are offered (Section 11.15). */
export function ViewSwitcher({
  offered,
  current,
}: {
  offered: readonly ViewType[];
  current: ViewType;
}) {
  const t = useTranslations("places.kit");
  const navigate = useQueryNavigation();
  if (offered.length < 2) return null;
  return (
    <CollectionViews
      label={t("views.label")}
      value={current}
      options={offered.map((v) => ({ value: v, label: t(`views.${v}`) }))}
      onChange={(view) => navigate({ view }, "replace")}
    />
  );
}

/**
 * A drawer opened by a query key (`create=1`, `peek=<id>`): closing it removes the keys, so Esc,
 * the close button and the browser back button agree.
 */
export function QueryDrawer({
  title,
  closeKeys,
  footer,
  children,
}: {
  title: string;
  closeKeys: readonly string[];
  footer?: ReactNode;
  children: ReactNode;
}) {
  const navigate = useQueryNavigation();
  return (
    <Drawer
      title={title}
      open
      onOpenChange={(open) => {
        if (!open) navigate(Object.fromEntries(closeKeys.map((k) => [k, undefined])), "replace");
      }}
      {...(footer ? { footer } : {})}
    >
      {children}
    </Drawer>
  );
}

/** The table view: Enter or a click on a row opens its peek. */
export function PeekTable({
  label,
  columns,
  rows,
  pinStart,
}: {
  label: string;
  columns: DataTableColumn[];
  rows: (Record<string, unknown> & { id: string })[];
  pinStart?: string[];
}) {
  const navigate = useQueryNavigation();
  // The list's filterable custom fields (A117), when the page wraps it in a CustomFieldList.
  const custom = useCustomFieldColumns();
  return (
    <DataTable
      label={label}
      caption={label}
      columns={[...columns, ...custom.columns]}
      rows={custom.columns.length > 0 ? rows.map((r) => ({ ...r, ...custom.cells(r.id) })) : rows}
      height="auto"
      {...(pinStart ? { pinStart } : {})}
      onRowActivate={(row) => navigate({ peek: String(row["id"]) })}
    />
  );
}

/**
 * The board view. Moving a card calls `onMoveAction` with the card and the two columns; the server
 * decides whether the move is allowed and the page re-renders from the database either way.
 */
export function PeekBoard({
  columns,
  readOnly,
  onMoveAction,
}: {
  columns: BoardProps["columns"];
  readOnly?: boolean;
  onMoveAction?: (cardKey: string, from: string, to: string) => Promise<void>;
}) {
  const navigate = useQueryNavigation();
  const router = useRouter();
  return (
    <Board
      columns={columns}
      readOnly={readOnly ?? onMoveAction === undefined}
      onOpen={(key) => navigate({ peek: key })}
      {...(onMoveAction
        ? {
            onMove: (key: string, from: string, to: string) => {
              void onMoveAction(key, from, to).then(() => router.refresh());
            },
          }
        : {})}
    />
  );
}

/** The calendar view: choosing an event opens its peek. Event labels carry the record id. */
export function PeekCalendar({
  month,
  today,
  events,
}: {
  month: string;
  today: string;
  events: (CalendarProps["events"][number] & { id: string })[];
}) {
  const navigate = useQueryNavigation();
  return (
    <Calendar
      month={month}
      today={today}
      events={events}
      onEventSelect={(event) => {
        const match = events.find((e) => e.date === event.date && e.label === event.label);
        if (match) navigate({ peek: match.id });
      }}
    />
  );
}

/** The tree view: choosing a node with an id opens its peek. */
export function PeekTree({ label, nodes }: { label: string; nodes: TreeNode[] }) {
  const navigate = useQueryNavigation();
  return (
    <TreeView
      label={label}
      nodes={nodes}
      onSelect={(node) => {
        if (node.id) navigate({ peek: node.id });
      }}
    />
  );
}
