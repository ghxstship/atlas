"use client";

import type { ProjectRef, RecordStateInfo, RecordSummary } from "@xos/data/work";
import type { TimelineModel } from "@xos/data/schedule";
import {
  Board,
  Button,
  Calendar,
  DataTable,
  EmptyState,
  Input,
  PageHeader,
  RecordKindChip,
  RecordList,
  RecordRow,
  Select,
  TemplateCollection,
  Timeline,
  rememberOverlayOpener,
  type RecordKind,
} from "@xos/ui";
import type { Route } from "next";
import { useFormatter, useLocale } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { ActionErrorAlert, useAction, useCopy } from "./action-ui";
import { transitionRecordAction } from "./actions";
import { formatScheduleTime, formatWhen, stateToken, withQuery } from "./format";
import { useScheduleView } from "./use-schedule-view";
import { displayTimeZone } from "@xos/ui/preferences";
import { TransitionDialog, useStateUndo } from "./record-panels";
import { CollectionViews } from "@/components/views/collection-views";
import type { BulkConfig } from "@/components/bulk/types";
import { useBulk } from "@/components/bulk/use-bulk";
import { useHoverCards } from "@/components/hover/use-hover-cards";
import { useRowMenu } from "@/components/menus/use-row-menu";

export type RecordView = "list" | "table" | "board" | "calendar" | "timeline";

export interface CollectionFilters {
  readonly q: string;
  readonly kinds: readonly string[];
  readonly states: readonly string[];
  readonly project: string;
  readonly sort: string;
}

const SORTS = ["key", "next", "title", "state", "updated"] as const;

/**
 * A record collection (Collection template, Section 11.6) over the record spine: the views the
 * sitemap lists for the page, a search, kind, state and project filters and a sort, all kept in
 * the query string so every view shows the same records and a link reopens the same state
 * (Section 11.15). Rows open the side peek (`?peek=KEY`), which the page renders on the server.
 */
export function RecordCollection({
  title,
  label,
  emptyKey,
  records,
  total,
  views,
  view,
  filters,
  kinds,
  states,
  projects,
  boardBy = "state",
  month,
  today,
  timeZone,
  timeline,
  canCreate,
  create,
  peek,
  org,
  hideKindFilter = false,
  bulk,
}: {
  title: string;
  label: string;
  /** Key under work.empty: the page's teaching empty state. */
  emptyKey: string;
  records: readonly RecordSummary[];
  /** Records before filtering, to tell an empty page from an empty filter. */
  total: number;
  views: readonly string[];
  view: string;
  filters: CollectionFilters;
  kinds: readonly string[];
  states: readonly RecordStateInfo[];
  projects: readonly ProjectRef[];
  boardBy?: "state" | "kind";
  month: string;
  today: string;
  timeZone: string;
  timeline: TimelineModel | null;
  canCreate: boolean;
  create?: ReactNode;
  peek?: ReactNode;
  org: string;
  hideKindFilter?: boolean;
  /** Bulk edit of the table view's selection, for people who may change records. */
  bulk?: BulkConfig | null;
}) {
  const t = useCopy("work");
  const format = useFormatter();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [search, setSearch] = useState(filters.q);
  const move = useAction();
  const pushUndo = useStateUndo(org);
  const [pendingMove, setPendingMove] = useState<{ record: RecordSummary; next: string } | null>(
    null,
  );

  const bulkRows = useMemo(
    () => records.map((r) => ({ id: r.id, label: r.key, version: r.updatedAt })),
    [records],
  );
  const bulkKit = useBulk(view === "table" ? bulk : null, bulkRows);
  const { selection, bar } = bulkKit;
  const rowMenu = useRowMenu();
  const go = (changes: Record<string, string | null>) =>
    router.replace(withQuery(pathname, params, changes) as Route, { scroll: false });
  // The page renders the peek for `?peek` after the section's loading state, which can take focus
  // from the row; the peek hands it back to the control remembered here.
  const open = (key: string) => {
    rememberOverlayOpener();
    router.push(withQuery(pathname, params, { peek: key }) as Route, { scroll: false });
  };
  const kindLabel = (kind: string) => t(`kinds.${kind}`);
  const stateLabel = (state: string) => t(`states.${state}`);
  // Schedule times follow me.time_zone_display and carry their zone abbreviation (Section 15).
  const zoneView = useScheduleView();
  const when = (value: string | null, tz: string) =>
    formatScheduleTime(value, locale, tz, zoneView);
  const nextOf = (r: RecordSummary) => {
    const at =
      r.startsAt && r.startsAt > new Date().toISOString()
        ? r.startsAt
        : (r.dueAt ?? r.endsAt ?? r.startsAt);
    return when(at, r.timeZone ?? r.projectTimeZone);
  };
  // Hover cards (Section 11.7): the key or title previews the record, the owner the person.
  const hover = useHoverCards((index, column) => {
    const r = records[index];
    if (!r) return null;
    if (column === "owner") {
      return r.ownerId
        ? { kind: "person", org, personId: r.ownerId, name: r.ownerName ?? "" }
        : null;
    }
    if (column !== "key" && column !== "title") return null;
    return {
      kind: "record",
      recordKey: r.key,
      recordKind: r.kind as RecordKind,
      title: r.title,
      state: stateToken(r.state),
      stateLabel: t(`states.${r.state}`),
      owner: r.ownerName ?? t("values.unassigned"),
      next: nextOf(r) ?? t("values.noDate"),
    };
  });

  const header = (
    <PageHeader
      title={title}
      count={records.length}
      views={
        views.length > 1 ? (
          <CollectionViews
            label={t("collection.views")}
            value={view}
            options={views.map((v) => ({ value: v, label: t(`views.${v}`) }))}
            onChange={(v) => go({ view: v })}
          />
        ) : undefined
      }
      actions={canCreate ? create : undefined}
    />
  );

  const filterBar = (
    <>
      <form
        role="search"
        className="flex items-end gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          go({ q: search.trim() || null });
        }}
      >
        <Input
          id="records-search"
          type="search"
          label={t("collection.search")}
          placeholder={t("collection.searchHint")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button type="submit">{t("collection.apply")}</Button>
      </form>
      {hideKindFilter ? null : (
        <Select
          key={`kind-${filters.kinds.join(",")}`}
          id="records-kind"
          label={t("collection.kind")}
          value={filters.kinds[0] ?? ""}
          options={[
            { value: "", label: t("collection.allKinds") },
            ...kinds.map((k) => ({ value: k, label: kindLabel(k) })),
          ]}
          onChange={(e) => go({ kind: e.target.value || null })}
        />
      )}
      <Select
        key={`state-${filters.states.join(",")}`}
        id="records-state"
        label={t("collection.state")}
        value={filters.states[0] ?? ""}
        options={[
          { value: "", label: t("collection.allStates") },
          ...states.map((s) => ({ value: s.state, label: stateLabel(s.state) })),
        ]}
        onChange={(e) => go({ state: e.target.value || null })}
      />
      {projects.length > 1 ? (
        <Select
          key={`project-${filters.project}`}
          id="records-project"
          label={t("collection.project")}
          value={filters.project}
          options={[
            { value: "", label: t("collection.allProjects") },
            ...projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
          ]}
          onChange={(e) => go({ project: e.target.value || null })}
        />
      ) : null}
      <Select
        key={`sort-${filters.sort}`}
        id="records-sort"
        label={t("collection.sort")}
        value={filters.sort}
        options={SORTS.map((s) => ({ value: s, label: t(`collection.sorts.${s}`) }))}
        onChange={(e) => go({ sort: e.target.value })}
      />
    </>
  );

  const filtered =
    filters.q !== "" ||
    filters.kinds.length > 0 ||
    filters.states.length > 0 ||
    filters.project !== "";

  let body: ReactNode;
  if (total === 0 && !filtered) {
    body = (
      <EmptyState
        icon="ListPlus"
        sentence={t(`empty.${emptyKey}.sentence`)}
        actionLabel={canCreate ? t(`empty.${emptyKey}.action`) : t("empty.readOnlyAction")}
        onAction={() => (canCreate ? go({ create: "1" }) : router.push(`/${org}/my-work` as Route))}
      />
    );
  } else if (records.length === 0) {
    body = (
      <EmptyState
        icon="SearchX"
        sentence={t("empty.filtered")}
        actionLabel={t("collection.clear")}
        onAction={() => {
          setSearch("");
          go({ q: null, kind: null, state: null, project: null });
        }}
      />
    );
  } else if (view === "table") {
    body = (
      <div {...hover.hoverProps}>
        <DataTable
          caption={label}
          columns={[
            { key: "key", label: t("columns.key"), type: "code" },
            { key: "title", label: t("columns.title"), wrap: true },
            { key: "kind", label: t("columns.kind") },
            { key: "state", label: t("columns.state"), type: "state" },
            { key: "owner", label: t("columns.owner") },
            { key: "next", label: t("columns.next") },
            { key: "project", label: t("columns.project") },
          ]}
          rows={records.map((r) => ({
            id: r.id,
            key: r.key,
            title: r.title,
            kind: r.subtype
              ? `${kindLabel(r.kind)} · ${t(`subtypes.${r.kind}.${r.subtype}`)}`
              : kindLabel(r.kind),
            state: { state: stateToken(r.state), label: stateLabel(r.state) },
            owner: r.ownerName ?? t("values.unassigned"),
            next: nextOf(r) ?? t("values.noDate"),
            project: r.projectName,
          }))}
          onRowActivate={(row) => open(String(row["key"]))}
          onRowContextMenu={(_row, index, at, cell) => {
            const r = records[index];
            if (!r) return;
            rowMenu.open(
              {
                id: r.id,
                label: r.key,
                open: () => open(r.key),
                href: `/${org}/r/${encodeURIComponent(r.key)}`,
                bulk: bulkKit,
              },
              at,
              cell,
            );
          }}
          {...(selection ? { selection } : {})}
        />
        {rowMenu.menu}
        {hover.card}
      </div>
    );
  } else if (view === "board") {
    const columns =
      boardBy === "kind"
        ? kinds
            .filter((k) => records.some((r) => r.kind === k))
            .map((k) => ({
              state: "active" as const,
              label: kindLabel(k),
              cards: records
                .filter((r) => r.kind === k)
                .map((r) => ({
                  key: r.key,
                  title: r.title,
                  meta: stateLabel(r.state),
                  kind: r.kind as RecordKind,
                  ...(r.ownerName ? { owner: r.ownerName } : {}),
                  ...(nextOf(r) ? { due: nextOf(r) as string } : {}),
                })),
            }))
        : states.map((s) => ({
            state: stateToken(s.state),
            label: stateLabel(s.state),
            cards: records
              .filter((r) => r.state === s.state)
              .map((r) => ({
                key: r.key,
                title: r.title,
                meta: kindLabel(r.kind),
                kind: r.kind as RecordKind,
                ...(r.ownerName ? { owner: r.ownerName } : {}),
                ...(nextOf(r) ? { due: nextOf(r) as string } : {}),
              })),
          }));
    const tokenToState = new Map(states.map((s) => [stateToken(s.state), s.state]));
    body = (
      <section
        aria-label={boardBy === "kind" ? t("collection.kindBoard") : t("collection.stateBoard")}
      >
        <ActionErrorAlert error={move.error} />
        <Board
          key={records.map((r) => `${r.key}:${r.state}`).join("|")}
          readOnly={boardBy === "kind" || !canCreate}
          columns={columns}
          onOpen={open}
          onMove={(key, _from, to) => {
            const record = records.find((r) => r.key === key);
            const next = tokenToState.get(to);
            if (!record || !next) return;
            if (next === "Blocked" || next === "Deferred") {
              setPendingMove({ record, next });
              return;
            }
            const reason = t("transition.boardReason", { state: stateLabel(next) });
            move.run(
              () =>
                transitionRecordAction(org, {
                  recordId: record.id,
                  expected: record.state,
                  next,
                  reason,
                }),
              () => pushUndo(record, next, { reason }),
            );
          }}
        />
        {pendingMove ? (
          <TransitionDialog
            org={org}
            record={pendingMove.record}
            next={pendingMove.next}
            onClose={() => setPendingMove(null)}
          />
        ) : null}
      </section>
    );
  } else if (view === "calendar") {
    const byLabel = new Map<string, string>();
    const events = records.flatMap((r) => {
      // A record lands on its day in the zone its time shows in (me.time_zone_display).
      const tz =
        displayTimeZone(
          r.timeZone ?? r.projectTimeZone ?? timeZone,
          zoneView.display,
          zoneView.viewerZone,
        ) ?? timeZone;
      const at = r.startsAt ?? r.dueAt ?? r.endsAt;
      if (!at) return [];
      const date =
        formatWhen(at, "en-CA", tz, { year: "numeric", month: "2-digit", day: "2-digit" }) ?? "";
      if (!date.startsWith(month.slice(0, 7))) return [];
      const labelText = `${r.key} ${r.title}`;
      byLabel.set(labelText, r.key);
      return [{ date, label: labelText, state: stateToken(r.state) }];
    });
    const undated = records.filter((r) => !r.startsAt && !r.dueAt && !r.endsAt).length;
    body = (
      <div className="flex flex-col gap-8">
        <div className="flex gap-8">
          <Button onClick={() => go({ month: shiftMonth(month, -1) })}>
            {t("collection.previousMonth")}
          </Button>
          <Button onClick={() => go({ month: shiftMonth(month, 1) })}>
            {t("collection.nextMonth")}
          </Button>
        </div>
        <Calendar
          month={month}
          today={today}
          events={events}
          onEventSelect={(e) => {
            const key = byLabel.get(e.label);
            if (key) open(key);
          }}
        />
        {undated > 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("collection.undated", { count: undated })}
          </p>
        ) : null}
      </div>
    );
  } else if (view === "timeline") {
    body =
      timeline && timeline.bars.length > 0 ? (
        <div className="min-w-0">
          <Timeline
            label={label}
            days={timeline.days.map((d) => ({
              dow: format.dateTime(new Date(`${d.day}T12:00:00Z`), {
                weekday: "narrow",
                timeZone: "UTC",
              }),
              date: d.date,
              weekend: d.weekend,
            }))}
            dayWidth={timeline.days.length > 60 ? 16 : 32}
            {...(timeline.today !== undefined ? { today: timeline.today } : {})}
            rows={timeline.bars.map((b) => ({
              key: b.record.key,
              title: b.record.title,
              state: stateToken(b.record.state),
              start: b.start,
              end: b.end,
              ...(b.milestone ? { milestone: true } : {}),
              ...(b.dependsOn !== undefined ? { dependsOn: b.dependsOn } : {}),
              ...(b.baselineStart !== undefined ? { baselineStart: b.baselineStart } : {}),
              ...(b.baselineEnd !== undefined ? { baselineEnd: b.baselineEnd } : {}),
            }))}
          />
        </div>
      ) : (
        <EmptyState
          icon="CalendarRange"
          sentence={t("empty.noDates")}
          actionLabel={t("collection.showList")}
          onAction={() => go({ view: "list" })}
        />
      );
  } else {
    body = (
      <RecordList label={label}>
        {records.map((r) => (
          <RecordRow
            key={r.id}
            state={stateToken(r.state)}
            stateLabel={stateLabel(r.state)}
            recordKey={r.key}
            kind={r.kind as RecordKind}
            title={r.title}
            chips={<RecordKindChip kind={r.kind as RecordKind} label={kindLabel(r.kind)} />}
            {...(nextOf(r) ? { next: nextOf(r) as string } : {})}
            {...(r.ownerName ? { owner: r.ownerName } : {})}
            actionLabel={t("collection.open")}
            onAction={() => open(r.key)}
            onOpen={() => open(r.key)}
          />
        ))}
      </RecordList>
    );
  }

  return (
    <TemplateCollection header={header} filters={filterBar} peek={peek}>
      {body}
      {bar}
    </TemplateCollection>
  );
}

/** `2026-11-01` moved by whole months, as the first of that month. */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 10);
}
