"use client";

/**
 * Client views shared by the Logistics and Hospitality pages (A11). Every view takes plain data and
 * hrefs from the server page; opening a record moves the URL to `?peek={key}`, so the browser's back
 * button, links and reloads all land on the same record (Section 4.5.3).
 */
import {
  Board,
  Button,
  Calendar,
  DataTable,
  InlineAlert,
  PropertyChip,
  RecordList,
  RecordRow,
  SegmentedControl,
  SidePeek,
  UndoToast,
  ToastRegion,
  type DataTableColumn,
  type RecordKind,
  type RecordState,
} from "@xos/ui";
import type { Route } from "next";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import type { BulkConfig } from "@/components/bulk/types";
import { useBulk } from "@/components/bulk/use-bulk";
import { useRowMenu } from "@/components/menus/use-row-menu";
import { CollectionViews } from "@/components/views/collection-views";
import type { ActionState } from "@/lib/logistics-hospitality/actions-kit";
import { usePushTrash } from "./undo";

/** The URL of the current page with some query parameters replaced or removed. */
export function useHrefWith(): (changes: Record<string, string | null>) => string {
  const pathname = usePathname();
  const search = useSearchParams();
  return (changes) => {
    const next = new URLSearchParams(search.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  };
}

/** The view switcher: only views the data qualifies for are offered (Section 11.15). */
export function ViewSwitcher({
  label,
  current,
  options,
}: {
  label: string;
  current: string;
  options: readonly { value: string; label: string }[];
}) {
  const router = useRouter();
  const hrefWith = useHrefWith();
  if (options.length < 2) return null;
  return (
    <CollectionViews
      label={label}
      value={current}
      options={[...options]}
      onChange={(view) => router.replace(hrefWith({ view }) as Route, { scroll: false })}
    />
  );
}

/** A segmented control that switches a section of a page through one query parameter. */
export function SectionSwitcher({
  label,
  param,
  current,
  options,
}: {
  label: string;
  param: string;
  current: string;
  options: readonly { value: string; label: string }[];
}) {
  const router = useRouter();
  const hrefWith = useHrefWith();
  return (
    <SegmentedControl
      label={label}
      value={current}
      options={[...options]}
      onChange={(value) =>
        router.replace(hrefWith({ [param]: value, view: null, peek: null }) as Route, {
          scroll: false,
        })
      }
    />
  );
}

export interface ListItem {
  readonly key: string;
  readonly href: string;
  readonly state: RecordState;
  readonly stateLabel: string;
  readonly title: string;
  readonly chips: readonly string[];
  readonly next?: string;
  readonly owner?: string;
}

/** List view: J and K move, Enter or the Open button opens the peek. */
export function OperationsList({
  label,
  openLabel,
  items,
}: {
  label: string;
  openLabel: string;
  items: readonly ListItem[];
}) {
  const router = useRouter();
  return (
    <RecordList label={label}>
      {items.map((item) => {
        const open = () => router.push(item.href as Route, { scroll: false });
        return (
          <RecordRow
            key={item.key}
            recordKey={item.key}
            state={item.state}
            stateLabel={item.stateLabel}
            title={item.title}
            chips={item.chips.map((chip) => (
              <PropertyChip key={chip} value={chip} />
            ))}
            {...(item.next ? { next: item.next } : {})}
            {...(item.owner ? { owner: item.owner } : {})}
            actionLabel={openLabel}
            onAction={open}
            onOpen={open}
          />
        );
      })}
    </RecordList>
  );
}

/** A table row: its cells, the peek it opens and what its menu and the selection need. */
export type OperationsRow = Record<string, unknown> & {
  readonly href: string;
  /** The row's id, which the selection, bulk edit and its menu use. */
  readonly id?: string;
  /** The row's name in its menu and in a bulk refusal, such as its key. */
  readonly label?: string;
  /** The row's full page, for Open as a full page and Copy link. */
  readonly fullHref?: string;
  /** Set when the viewer may move the row to Trash: the Undo toast's sentence. */
  readonly trashMessage?: string;
};

/** Moving a row to Trash from its menu, the same server actions its peek's Delete runs. */
export interface OperationsTrash {
  readonly org: string;
  /** The menu item, such as Move to Trash or Cancel slot. */
  readonly label: string;
  readonly run: (org: string, id: string) => Promise<ActionState>;
  readonly restore: (org: string, id: string) => Promise<ActionState>;
}

/**
 * Table view: Enter on a cell or a double click opens the row. With `bulk`, rows select by click,
 * Cmd or Ctrl+click, Shift+click, X and Cmd or Ctrl+A, and the bulk bar changes a property across
 * the selection; right-click, Shift+F10 or the Context Menu key opens a row's menu with the actions
 * its peek and the bar offer, Move to Trash among them where `trash` allows (Section 11.7).
 */
export function OperationsTable({
  caption,
  columns,
  rows,
  totals,
  totalsLabel,
  bulk,
  trash,
}: {
  caption: string;
  columns: DataTableColumn[];
  rows: OperationsRow[];
  totals?: Record<string, unknown>;
  totalsLabel?: string;
  /** Bulk edit of a selection, for people who may change the rows; every row needs an id. */
  bulk?: BulkConfig | null;
  trash?: OperationsTrash;
}) {
  const router = useRouter();
  const te = useTranslations("logistics.common.errors") as unknown as (key: string) => string;
  const refs = useMemo(
    () => rows.flatMap((r) => (r.id ? [{ id: r.id, label: r.label ?? r.id }] : [])),
    [rows],
  );
  const selection = useBulk(bulk, refs);
  const rowMenu = useRowMenu();
  const pushTrash = usePushTrash();
  const [trashError, setTrashError] = useState<string | null>(null);
  const open = (row: OperationsRow) => router.push(row.href as Route, { scroll: false });
  const trashItem = (row: OperationsRow, id: string) => {
    const message = row.trashMessage;
    if (!trash || !message) return [];
    const run = () => trash.run(trash.org, id);
    const restore = () => trash.restore(trash.org, id);
    return [
      {
        label: trash.label,
        icon: "Trash2" as const,
        danger: true,
        onSelect: () => {
          setTrashError(null);
          void run().then((state) => {
            if (!state.ok) {
              setTrashError(te(state.error ?? "unexpected"));
              return;
            }
            pushTrash({ message, run, restore });
            router.refresh();
          });
        },
      },
    ];
  };
  return (
    <>
      {trashError ? (
        <InlineAlert tone="danger" title={trashError}>
          {null}
        </InlineAlert>
      ) : null}
      <DataTable
        caption={caption}
        columns={columns}
        rows={rows}
        pinStart={[columns[0]?.key ?? "key"]}
        {...(totals ? { totals } : {})}
        {...(totalsLabel ? { totalsLabel } : {})}
        onRowActivate={(row) => open(row as OperationsRow)}
        onRowContextMenu={(raw, _index, at, cell) => {
          const row = raw as OperationsRow;
          const id = row.id ?? row.href;
          rowMenu.open(
            {
              id,
              label: row.label ?? String(row[columns[0]?.key ?? "key"] ?? ""),
              open: () => open(row),
              ...(row.fullHref ? { href: row.fullHref } : {}),
              bulk: selection,
              ...(row.id ? { more: trashItem(row, row.id) } : {}),
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

export interface BoardColumn {
  readonly state: RecordState;
  readonly label: string;
  readonly cards: readonly { key: string; title: string; meta?: string; href: string }[];
}

/** Board view: cards group by state; they open but do not move, because state moves need a reason. */
export function OperationsBoard({ columns }: { columns: readonly BoardColumn[] }) {
  const router = useRouter();
  const hrefs = new Map(columns.flatMap((c) => c.cards.map((card) => [card.key, card.href])));
  return (
    <Board
      readOnly
      columns={columns.map((c) => ({
        state: c.state,
        label: c.label,
        cards: c.cards.map(({ key, title, meta }) => ({ key, title, ...(meta ? { meta } : {}) })),
      }))}
      onOpen={(key) => {
        const href = hrefs.get(key);
        if (href) router.push(href as Route, { scroll: false });
      }}
    />
  );
}

export interface CalendarItem {
  readonly date: string;
  readonly label: string;
  readonly state: RecordState;
  readonly href: string;
}

/** Calendar view with month navigation through the `month` parameter. */
export function OperationsCalendar({
  month,
  today,
  items,
  previousLabel,
  nextLabel,
  previousMonth,
  nextMonth,
}: {
  month: string;
  today: string;
  items: readonly CalendarItem[];
  previousLabel: string;
  nextLabel: string;
  previousMonth: string;
  nextMonth: string;
}) {
  const router = useRouter();
  const hrefWith = useHrefWith();
  const events = items.map(({ date, label, state }) => ({ date, label, state }));
  return (
    <div className="flex flex-col gap-8">
      <div className="flex gap-8">
        <Button
          size="sm"
          variant="ghost"
          icon="ChevronLeft"
          onClick={() => router.replace(hrefWith({ month: previousMonth }) as Route)}
        >
          {previousLabel}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="ChevronRight"
          onClick={() => router.replace(hrefWith({ month: nextMonth }) as Route)}
        >
          {nextLabel}
        </Button>
      </div>
      <Calendar
        month={month}
        today={today}
        events={events}
        onEventSelect={(event) => {
          const item = items[events.indexOf(event)];
          if (item) router.push(item.href as Route, { scroll: false });
        }}
      />
    </div>
  );
}

/**
 * The side peek of one record. Closing returns to the list; Open full adds `full=1`, the full page
 * of a domain entity that is not one of the 26 record kinds (broadcast 1, section 4).
 */
export function OperationsPeek({
  recordKey,
  kindLabel,
  title,
  state,
  stateLabel,
  chips,
  properties,
  children,
}: {
  recordKey: string;
  kindLabel: string;
  title: string;
  state: RecordState;
  stateLabel: string;
  chips?: ReactNode;
  properties: { label: string; value: ReactNode }[];
  children?: ReactNode;
}) {
  const router = useRouter();
  const hrefWith = useHrefWith();
  return (
    <SidePeek
      open
      onOpenChange={(open) => {
        if (!open)
          router.push(hrefWith({ peek: null, full: null, edit: null }) as Route, { scroll: false });
      }}
      onOpenFull={() => router.push(hrefWith({ full: "1" }) as Route)}
      onCopyLink={() => {
        void navigator.clipboard.writeText(
          new URL(hrefWith({ peek: recordKey, full: "1", edit: null }), window.location.origin)
            .href,
        );
      }}
      recordKey={recordKey}
      // Domain entities are not record kinds; the label names the entity and the glyph falls back.
      kind={kindLabel as RecordKind}
      title={title}
      state={state}
      stateLabel={stateLabel}
      chips={chips}
      properties={properties}
    >
      {children}
    </SidePeek>
  );
}

/** A message that offers Undo for 8 seconds after a record moves to Trash (Section 11.7). */
export function UndoNotice({
  region,
  message,
  onUndo,
}: {
  region: string;
  /** Null while there is nothing to undo; the live region stays mounted either way (A23-014). */
  message: string | null;
  onUndo: () => void;
}) {
  const [closed, setClosed] = useState<string | null>(null);
  const show = message !== null && message !== closed;
  return (
    <ToastRegion label={region}>
      {show ? (
        <UndoToast
          message={message}
          onUndo={() => {
            setClosed(message);
            onUndo();
          }}
          onExpire={() => setClosed(message)}
        />
      ) : null}
    </ToastRegion>
  );
}
