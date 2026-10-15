"use client";

import {
  Board,
  Calendar,
  Card,
  Chart,
  DataTable,
  EmptyState,
  Gallery,
  Input,
  PageHeader,
  RecordList,
  RecordRow,
  SegmentedControl,
  StateChip,
  TemplateCollection,
  type RecordState,
} from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { KitBoardColumn, KitChart, KitColumn, KitRow, ViewKind } from "./types";

/**
 * The Collection template (Section 11.6) for every A16 list: page header with the view switcher
 * and primary action, a search filter that survives view switches (Section 11.15), and the table,
 * list, board, gallery, calendar or chart body. Opening a row sets `?peek=<id>`; the page renders
 * the side peek or, with `&full=1`, the full record page.
 */
export function CollectionView({
  title,
  views,
  view,
  columns,
  rows,
  board,
  chart,
  month,
  empty,
  actions,
  filters,
  children,
}: {
  title: string;
  views: readonly ViewKind[];
  view: ViewKind;
  columns: readonly KitColumn[];
  rows: readonly KitRow[];
  board?: readonly KitBoardColumn[];
  chart?: KitChart;
  /** First day of the calendar month shown, YYYY-MM-01. */
  month?: string;
  /** The empty state when the collection has no rows at all. */
  empty: ReactNode;
  actions?: ReactNode;
  filters?: ReactNode;
  /** The peek or create drawer, rendered after the body. */
  children?: ReactNode;
}) {
  const t = useTranslations("procurement.kit");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");

  const href = (changes: Record<string, string | null>): Route => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    return (qs ? `${pathname}?${qs}` : pathname) as Route;
  };
  const open = (id: string) => router.push(href({ peek: id, full: null, create: null }));

  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      needle === ""
        ? rows
        : rows.filter((r) =>
            [r.key, r.title, r.meta ?? "", ...Object.values(r.cells).map(cellText)]
              .join(" ")
              .toLowerCase()
              .includes(needle),
          ),
    [rows, needle],
  );

  const switcher =
    views.length > 1 ? (
      <SegmentedControl
        label={t("views")}
        value={view}
        options={views.map((v) => ({ value: v, label: t(`view.${v}`) }))}
        onChange={(next) => router.replace(href({ view: next }), { scroll: false })}
      />
    ) : null;

  const searchBox =
    rows.length > 0 ? (
      <div className="w-full max-w-[min(100%,calc(var(--space-40)*8))]">
        <Input
          id="collection-search"
          type="search"
          width="100%"
          label={t("search")}
          placeholder={t("searchPlaceholder")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            router.replace(href({ q: e.target.value }), { scroll: false });
          }}
        />
      </div>
    ) : null;

  let body: ReactNode;
  if (rows.length === 0) {
    body = empty;
  } else if (visible.length === 0) {
    body = (
      <EmptyState
        icon="SearchX"
        sentence={t("noMatches")}
        actionLabel={t("clearSearch")}
        onAction={() => {
          setQuery("");
          router.replace(href({ q: null }), { scroll: false });
        }}
      />
    );
  } else if (view === "list") {
    body = (
      <RecordList label={title}>
        {visible.map((r) => (
          <RecordRow
            key={r.id}
            state={r.state?.state ?? "proposed"}
            stateLabel={r.state?.label ?? ""}
            recordKey={r.key}
            title={r.title}
            {...(r.meta ? { next: r.meta } : {})}
            actionLabel={t("open")}
            onAction={() => open(r.id)}
            onOpen={() => open(r.id)}
          />
        ))}
      </RecordList>
    );
  } else if (view === "board" && board) {
    body = (
      <Board
        readOnly
        columns={board.map((c) => ({
          state: c.state,
          label: c.label,
          cards: visible
            .filter((r) => r.boardValue === c.value)
            .map((r) => ({ key: r.id, title: `${r.key} ${r.title}`, ...(r.meta ? { meta: r.meta } : {}) })),
        }))}
        onOpen={open}
      />
    );
  } else if (view === "gallery") {
    body = (
      <Gallery label={title}>
        {visible.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => open(r.id)}
            className="block w-full p-0 border-0 bg-transparent text-start cursor-pointer rounded-card focus-visible:outline-(length:--stroke-width-focus) focus-visible:outline-focus-ring"
          >
            <Card
              title={r.title}
              interactive
              meta={<span className="font-mono text-text-12">{r.key}</span>}
              {...(r.state ? { footer: <StateChip state={r.state.state} label={r.state.label} compact /> } : {})}
            >
              <span className="text-text-13 text-text-secondary">{r.meta ?? ""}</span>
            </Card>
          </button>
        ))}
      </Gallery>
    );
  } else if (view === "calendar" && month) {
    const dated = visible.filter((r) => r.date);
    body = (
      <Calendar
        month={month}
        events={dated.map((r) => ({
          date: r.date as string,
          label: `${r.key} ${r.title}`,
          state: (r.state?.state ?? "scheduled") as RecordState,
        }))}
        onEventSelect={(e) => {
          const row = dated.find((r) => `${r.key} ${r.title}` === e.label && r.date === e.date);
          if (row) open(row.id);
        }}
      />
    );
  } else if (view === "chart" && chart) {
    body = (
      <Chart
        type="bar"
        title={chart.title}
        categoryLabel={chart.categoryLabel}
        categories={[...chart.categories]}
        series={chart.series.map((s) => ({ name: s.name, values: [...s.values] }))}
        {...(chart.format ? { format: chart.format } : {})}
        {...(chart.currency ? { currency: chart.currency } : {})}
      />
    );
  } else {
    const tableRows = visible.map((r) => ({ id: r.id, ...r.cells }));
    body = (
      <DataTable
        caption={title}
        label={title}
        columns={columns.map((c) => ({ ...c }))}
        rows={tableRows}
        onRowActivate={(row) => open(String(row["id"]))}
      />
    );
  }

  return (
    <TemplateCollection
      header={<PageHeader title={title} count={rows.length} views={switcher} actions={actions} />}
      filters={
        searchBox || filters ? (
          <>
            {searchBox}
            {filters}
            {needle !== "" ? (
              <p role="status" className="m-0 text-text-12 text-text-secondary">
                {t("results", { count: visible.length })}
              </p>
            ) : null}
          </>
        ) : undefined
      }
      peek={children}
    >
      {body}
    </TemplateCollection>
  );
}

function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "object" && "label" in cell) return String((cell as { label: string }).label);
  return String(cell);
}
