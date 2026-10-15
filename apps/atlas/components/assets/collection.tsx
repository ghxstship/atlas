"use client";

import {
  Board,
  Button,
  Calendar,
  Card,
  DataTable,
  Drawer,
  EmptyState,
  Gallery,
  Input,
  PageHeader,
  RecordList,
  RecordRow,
  ResourceSchedule,
  SegmentedControl,
  Select,
  TemplateCollection,
  type DataTableColumn,
  type RecordState,
  type ResourceScheduleProps,
} from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useAssetsCopy } from "./copy";
import { CreateDialogContext } from "./dialog";

/** One row of an assets collection, already shaped for every view the page offers. */
export interface CollectionRow {
  readonly key: string;
  /** Value of `?peek=` that opens this row; rows without one do not open. */
  readonly peek?: string;
  readonly title: string;
  readonly meta?: string;
  readonly tone?: RecordState;
  readonly stateLabel?: string;
  /** Board column value. */
  readonly group?: string;
  /** ISO date for the calendar view. */
  readonly date?: string;
  readonly cells: Record<string, unknown>;
}

export interface ViewOption {
  readonly value: string;
  readonly label: string;
}

export interface CollectionProps {
  readonly title: string;
  readonly view: string;
  readonly views: readonly ViewOption[];
  readonly columns: DataTableColumn[];
  readonly rows: readonly CollectionRow[];
  /** Rows before the search and state filter; tells an empty collection from no matches. */
  readonly total: number;
  readonly boardColumns?: readonly { value: string; label: string; tone: RecordState }[];
  readonly schedule?: Omit<ResourceScheduleProps, "label">;
  /** First day of the calendar month, ISO. */
  readonly month?: string;
  readonly today?: string;
  /** Options of the state filter, when the page has one. */
  readonly filterOptions?: readonly ViewOption[];
  /** The one primary action: its label and the dialog it opens (a form using CreateDialogContext). */
  readonly create?: { label: string; dialog: ReactNode } | null;
  /**
   * Shown when the collection has no rows at all: one sentence and the next action. The action opens
   * the create dialog, or follows `href` for viewers who cannot create.
   */
  readonly empty: { sentence: string; actionLabel: string; href?: string };
  /** The record peek, rendered by the page when `?peek=` names a row. */
  readonly peek?: { title: string; content: ReactNode } | null;
  readonly before?: ReactNode;
}

/**
 * The Collection template for every assets page (Section 11.6): header with title, count, view
 * switcher and one primary action; a search and state filter; the body in the chosen view; and the
 * side peek. View, filter, search and peek live in the query string (Section 4.5.3), so switching
 * views keeps the filters and a link reopens the same state.
 */
export function AssetsCollection(props: CollectionProps) {
  const t = useAssetsCopy();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [q, setQ] = useState(search.get("q") ?? "");
  const [creating, setCreating] = useState(false);

  const go = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(search.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    router.replace(`${pathname}${query ? `?${query}` : ""}` as Route, { scroll: false });
  };
  const open = (peek: string | undefined) => {
    if (peek) go({ peek, full: null });
  };
  const byKey = new Map(props.rows.map((r) => [r.key, r]));
  const filtered = Boolean(search.get("q") || search.get("filter"));

  const header = (
    <PageHeader
      title={props.title}
      count={props.total}
      views={
        props.views.length > 1 ? (
          <SegmentedControl
            label={t("collection.view")}
            value={props.view}
            options={props.views.map((v) => ({ value: v.value, label: v.label }))}
            onChange={(view) => go({ view })}
          />
        ) : null
      }
      actions={
        props.create ? (
          <Button variant="primary" icon="Plus" onClick={() => setCreating(true)}>
            {props.create.label}
          </Button>
        ) : null
      }
    />
  );

  const filters =
    props.total > 0 ? (
      <form
        role="search"
        aria-label={t("collection.filters")}
        className="flex flex-wrap items-end gap-8"
        onSubmit={(e) => {
          e.preventDefault();
          go({ q: q.trim() || null });
        }}
      >
        <Input
          id="assets-search"
          type="search"
          label={t("collection.search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          width={240}
        />
        {props.filterOptions ? (
          <Select
            id="assets-filter"
            label={t("collection.state")}
            value={search.get("filter") ?? ""}
            options={[
              { value: "", label: t("collection.allStates") },
              ...props.filterOptions.map((o) => ({ value: o.value, label: o.label })),
            ]}
            onChange={(e) => go({ filter: e.target.value || null })}
          />
        ) : null}
        <Button type="submit" variant="secondary">
          {t("collection.apply")}
        </Button>
        {filtered ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setQ("");
              go({ q: null, filter: null });
            }}
          >
            {t("collection.clear")}
          </Button>
        ) : null}
      </form>
    ) : null;

  let body: ReactNode;
  if (props.total === 0) {
    const { href } = props.empty;
    body = (
      <EmptyState
        icon="Package"
        sentence={props.empty.sentence}
        actionLabel={props.empty.actionLabel}
        onAction={() => {
          if (props.create) setCreating(true);
          else if (href) router.push(href as Route);
        }}
      />
    );
  } else if (props.rows.length === 0) {
    body = (
      <EmptyState
        icon="SearchX"
        sentence={t("collection.noMatches")}
        actionLabel={t("collection.clear")}
        onAction={() => {
          setQ("");
          go({ q: null, filter: null });
        }}
      />
    );
  } else {
    body = renderView(props, t, open, byKey);
  }

  return (
    <TemplateCollection
      header={
        <>
          {header}
          {props.before}
        </>
      }
      filters={filters}
      peek={
        props.peek ? (
          <Drawer
            open
            title={props.peek.title}
            onOpenChange={(next) => {
              if (!next) go({ peek: null, full: null });
            }}
            footer={
              <Button variant="secondary" onClick={() => go({ full: "1" })}>
                {t("collection.openFull")}
              </Button>
            }
          >
            {props.peek.content}
          </Drawer>
        ) : null
      }
    >
      {body}
      {props.create && creating ? (
        <CreateDialogContext value={{ open: creating, setOpen: setCreating }}>
          {props.create.dialog}
        </CreateDialogContext>
      ) : null}
    </TemplateCollection>
  );
}

function renderView(
  props: CollectionProps,
  t: ReturnType<typeof useAssetsCopy>,
  open: (peek: string | undefined) => void,
  byKey: Map<string, CollectionRow>,
): ReactNode {
  switch (props.view) {
    case "list":
      return (
        <RecordList label={props.title}>
          {props.rows.map((row) => (
            <RecordRow
              key={row.key}
              recordKey={row.peek ?? row.key}
              title={row.title}
              state={row.tone ?? "ready"}
              stateLabel={row.stateLabel ?? ""}
              {...(row.meta ? { next: row.meta } : {})}
              {...(row.peek ? { onOpen: () => open(row.peek) } : {})}
              {...(row.peek
                ? { actionLabel: t("collection.open"), onAction: () => open(row.peek) }
                : {})}
            />
          ))}
        </RecordList>
      );
    case "board":
      return (
        <Board
          readOnly
          columns={(props.boardColumns ?? []).map((c) => ({
            state: c.tone,
            label: c.label,
            cards: props.rows
              .filter((r) => r.group === c.value)
              .map((r) => ({ key: r.key, title: r.title, ...(r.meta ? { meta: r.meta } : {}) })),
          }))}
          onOpen={(key) => open(byKey.get(key)?.peek)}
        />
      );
    case "gallery":
      return (
        <Gallery label={props.title}>
          {props.rows.map((row) => {
            const card = (
              <Card title={row.title} meta={row.stateLabel} interactive={Boolean(row.peek)}>
                <p className="m-0 text-text-13 text-text-secondary">{row.meta}</p>
              </Card>
            );
            return row.peek ? (
              <NextLink
                key={row.key}
                href={`?peek=${encodeURIComponent(row.peek)}` as Route}
                scroll={false}
                className="rounded-card focus-visible:outline-2 focus-visible:outline-accent"
              >
                {card}
              </NextLink>
            ) : (
              <div key={row.key}>{card}</div>
            );
          })}
        </Gallery>
      );
    case "calendar":
      return (
        <Calendar
          month={props.month ?? new Date().toISOString().slice(0, 8) + "01"}
          {...(props.today ? { today: props.today } : {})}
          events={props.rows
            .filter((r) => r.date)
            .map((r) => ({ date: r.date ?? "", label: r.title, state: r.tone ?? "ready" }))}
        />
      );
    case "resource-schedule":
      return props.schedule ? <ResourceSchedule label={props.title} {...props.schedule} /> : null;
    default:
      return (
        <DataTable
          caption={props.title}
          columns={props.columns}
          rows={props.rows.map((r) => ({ ...r.cells, __key: r.key }))}
          onRowActivate={(row) => open(byKey.get(String(row["__key"]))?.peek)}
        />
      );
  }
}
