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
  StateChip,
  TemplateCollection,
  TreeView,
  rememberOverlayOpener,
  type TreeNode,
  type RecordState,
  type LiveTopic,
} from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { useCopy } from "./use-copy";
import type { KitBoardColumn, KitChart, KitColumn, KitRow, KitTreeNode, ViewKind } from "./types";
import { CollectionViews } from "@/components/views/collection-views";
import { useLiveRefresh } from "@/components/live/live-refresh";
import type { BulkConfig } from "@/components/bulk/types";
import { useBulk } from "@/components/bulk/use-bulk";
import { useHoverCards } from "@/components/hover/use-hover-cards";
import { useRowMenu } from "@/components/menus/use-row-menu";
import { collectionPeek } from "@/components/shell/collection-peek";

/** Views whose rows select, open a menu and preview the same way (Section 11.7). */
const ITEM_VIEWS = new Set<ViewKind>(["table", "list", "board", "calendar"]);

/**
 * The Collection template (Section 11.6) for every A16 list: page header with the view switcher
 * and primary action, a search filter that survives view switches (Section 11.15), and the table,
 * list, board, gallery, calendar or chart body. Opening a row sets `?peek=<id>`; the page renders
 * the side peek or, with `&full=1`, the full record page, and a key it has no row for is handed to
 * the shell's peek.
 */
export function CollectionView({
  title,
  views,
  view,
  columns,
  rows,
  board,
  chart,
  tree,
  month,
  searchable = true,
  empty,
  actions,
  filters,
  live,
  bulk,
  children,
}: {
  title: string;
  views: readonly ViewKind[];
  view: ViewKind;
  columns: readonly KitColumn[];
  rows: readonly KitRow[];
  board?: readonly KitBoardColumn[];
  chart?: KitChart;
  tree?: readonly KitTreeNode[];
  /** False when the page searches on the server (large canon tables) instead of filtering rows here. */
  searchable?: boolean;
  /** First day of the calendar month shown, YYYY-MM-01. */
  month?: string;
  /** The empty state when the collection has no rows at all. */
  empty: ReactNode;
  actions?: ReactNode;
  filters?: ReactNode;
  /**
   * Tables the rows come from, narrowed to the org (`org_id=eq.<id>`): the page rereads when one
   * changes, so the list updates live (Section 11.7, ADR 0044).
   */
  live?: readonly LiveTopic[];
  /**
   * Bulk edit of a selection (Section 11.7) in the table, list, board and calendar, for resources
   * with a bulk RPC.
   */
  bulk?: BulkConfig | null;
  /** The peek or create drawer, rendered after the body. */
  children?: ReactNode;
}) {
  const t = useCopy("procurement.kit");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  useLiveRefresh(live ?? null);
  const bulkRows = useMemo(() => rows.map((r) => ({ id: r.id, label: r.key })), [rows]);
  const bulkKit = useBulk(ITEM_VIEWS.has(view) ? bulk : null, bulkRows);
  const { selection, bar } = bulkKit;
  const rowMenu = useRowMenu();

  const href = (changes: Record<string, string | null>): Route => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    return (qs ? `${pathname}?${qs}` : pathname) as Route;
  };
  // The page renders the peek after the section's loading state, which can take focus from the row;
  // the peek hands it back to the control remembered here.
  const open = (id: string) => {
    rememberOverlayOpener();
    router.push(href({ peek: id, full: null, create: null }));
  };
  const byId = new Map(rows.map((r) => [r.id, r]));
  // A row's menu and hover card, the same in every view (Section 11.7).
  const menuFor = (id: string, at: { x: number; y: number } | null, element: HTMLElement) =>
    rowMenu.open(
      {
        id,
        label: byId.get(id)?.key ?? id,
        open: () => open(id),
        href: href({ peek: id, full: "1", create: null }),
        bulk: bulkKit,
      },
      at,
      element,
    );
  const hover = useHoverCards((id, column) => {
    const r = byId.get(id);
    if (!r || (column !== "key" && column !== "title")) return null;
    return {
      kind: "record",
      recordKey: r.key,
      title: r.title,
      ...(r.state ? { state: r.state.state, stateLabel: r.state.label } : {}),
      ...(r.meta ? { detail: r.meta } : {}),
    };
  });
  // The page renders the peek for `?peek` as children. With none (a stale link, a key from elsewhere)
  // the key goes to the shell's peek, which opens the record it names or says it cannot.
  const peek = collectionPeek(params.get("peek"), children);

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
      <CollectionViews
        label={t("views")}
        value={view}
        options={views.map((v) => ({ value: v, label: t(`view.${v}`) }))}
        onChange={(next) => router.replace(href({ view: next }), { scroll: false })}
      />
    ) : null;

  const searchBox =
    searchable && rows.length > 0 ? (
      <div className="w-full max-w-[min(100%,calc(var(--space-40)*8))]">
        <Input
          id="collection-search"
          type="search"
          width="100%"
          label={t("search")}
          placeholder={t("searchHint")}
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
      <RecordList label={title} onItemContextMenu={menuFor} {...(selection ? { selection } : {})}>
        {visible.map((r) => (
          <RecordRow
            key={r.id}
            id={r.id}
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
            .map((r) => ({
              key: r.id,
              title: `${r.key} ${r.title}`,
              ...(r.meta ? { meta: r.meta } : {}),
            })),
        }))}
        onItemContextMenu={menuFor}
        {...(selection ? { selection } : {})}
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
              {...(r.state
                ? { footer: <StateChip state={r.state.state} label={r.state.label} compact /> }
                : {})}
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
          id: r.id,
          date: r.date as string,
          label: `${r.key} ${r.title}`,
          state: (r.state?.state ?? "scheduled") as RecordState,
        }))}
        onEventSelect={(e) => {
          if (e.id) open(e.id);
        }}
        onItemContextMenu={menuFor}
        {...(selection ? { selection } : {})}
      />
    );
  } else if (view === "tree" && tree) {
    const rowIds = new Set(rows.map((r) => r.id));
    const toNode = (n: KitTreeNode): TreeNode => ({
      id: n.id,
      label: n.label,
      ...(n.meta ? { meta: n.meta } : {}),
      ...(n.children && n.children.length > 0 ? { children: n.children.map(toNode) } : {}),
    });
    body = (
      <TreeView
        label={title}
        nodes={tree.map(toNode)}
        onSelect={(node) => {
          if (node.id && rowIds.has(node.id)) open(node.id);
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
        onRowContextMenu={(row, _index, at, cell) => menuFor(String(row["id"]), at, cell)}
        {...(selection ? { selection } : {})}
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
      peek={peek}
    >
      {ITEM_VIEWS.has(view) && visible.length > 0 ? <div {...hover.hoverProps}>{body}</div> : body}
      {bar}
      {rowMenu.menu}
      {hover.card}
    </TemplateCollection>
  );
}

function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "object" && "label" in cell) return String((cell as { label: string }).label);
  return String(cell);
}
