"use client";

import {
  Board,
  Button,
  Calendar,
  DataTable,
  RecordList,
  RecordRow,
  type RecordKind,
  type RecordState,
} from "@xos/ui";
import type { Route } from "next";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CollectionViews } from "@/components/views/collection-views";

type DueState = "overdue" | "today" | "upcoming" | "undated";

/** One record on My Work, with every label already formatted on the server. */
export interface MyWorkRow {
  readonly key: string;
  readonly title: string;
  readonly kind: string;
  readonly state: RecordState;
  readonly stateLabel: string;
  readonly project: string;
  /** "Due Oct 17, 3:00 PM", "Starts ..." or "No due date". */
  readonly when: string;
  /** The due or start time alone, for the table. */
  readonly due: string;
  readonly dueState: DueState;
  /** Calendar day in the viewer's time zone, YYYY-MM-DD, or null without a date. */
  readonly date: string | null;
  readonly roles: string;
}

export interface MyWorkGroup {
  readonly state: DueState;
  readonly rows: readonly MyWorkRow[];
}

/** Design system state of each due group's board column. */
const COLUMN_STATE: Readonly<Record<DueState, RecordState>> = {
  overdue: "blocked",
  today: "active",
  upcoming: "scheduled",
  undated: "proposed",
};

/**
 * My Work (Section 4.5.4): the viewer's open records across projects, grouped overdue, today,
 * upcoming and undated, as a list, a table, a board or a calendar. A record opens in the shell's
 * side peek (`?peek={recordKey}`), and Open full page goes to the record.
 */
export function MyWorkView({
  groups,
  views,
  view,
  month,
  prevMonth,
  nextMonth,
}: {
  groups: readonly MyWorkGroup[];
  views: readonly string[];
  view: string;
  /** First day of the calendar month shown, YYYY-MM-01. */
  month: string;
  prevMonth: string;
  nextMonth: string;
}) {
  const t = useTranslations("myWork");
  const v = useTranslations("projects.views") as unknown as (key: string) => string;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const href = (changes: Record<string, string | null>): Route => {
    const next = new URLSearchParams(params.toString());
    for (const [k, value] of Object.entries(changes)) {
      if (value === null) next.delete(k);
      else next.set(k, value);
    }
    const qs = next.toString();
    return (qs ? `${pathname}?${qs}` : pathname) as Route;
  };
  const open = (key: string) => router.push(href({ peek: key }), { scroll: false });
  const rows = groups.flatMap((g) => g.rows);

  const switcher = (
    <CollectionViews
      label={t("views")}
      value={view}
      options={views.map((x) => ({ value: x, label: v(x) }))}
      onChange={(x) => router.replace(href({ view: x }), { scroll: false })}
    />
  );

  let body;
  if (view === "table") {
    body = (
      <DataTable
        caption={t("label")}
        label={t("label")}
        columns={[
          { key: "key", label: t("columns.key"), type: "code" },
          { key: "title", label: t("columns.title"), wrap: true },
          { key: "project", label: t("columns.project") },
          { key: "state", label: t("columns.state"), type: "state" },
          { key: "when", label: t("columns.when") },
          { key: "due", label: t("columns.due") },
          { key: "roles", label: t("columns.roles") },
        ]}
        rows={rows.map((r) => ({
          id: r.key,
          key: r.key,
          title: r.title,
          project: r.project,
          state: { state: r.state, label: r.stateLabel },
          when: t(`groups.${r.dueState}`),
          due: r.due,
          roles: r.roles,
        }))}
        onRowActivate={(row) => open(String(row["id"]))}
      />
    );
  } else if (view === "board") {
    body = (
      <Board
        readOnly
        columns={groups.map((g) => ({
          state: COLUMN_STATE[g.state],
          label: t(`groups.${g.state}`),
          cards: g.rows.map((r) => ({
            key: r.key,
            title: `${r.key} ${r.title}`,
            meta: `${r.project} · ${r.when}`,
          })),
        }))}
        onOpen={open}
      />
    );
  } else if (view === "calendar") {
    const dated = rows.filter((r) => r.date !== null);
    const undated = rows.length - dated.length;
    body = (
      <div className="flex flex-col gap-12">
        <div className="flex flex-wrap items-center gap-8">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => router.replace(href({ month: prevMonth }), { scroll: false })}
          >
            {t("previousMonth")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => router.replace(href({ month: nextMonth }), { scroll: false })}
          >
            {t("nextMonth")}
          </Button>
        </div>
        <Calendar
          month={month}
          events={dated.map((r) => ({
            date: r.date as string,
            label: `${r.key} ${r.title}`,
            state: r.state,
          }))}
          onEventSelect={(e) => {
            const row = dated.find((r) => `${r.key} ${r.title}` === e.label && r.date === e.date);
            if (row) open(row.key);
          }}
        />
        {undated > 0 ? (
          <p className="m-0 text-text-12 text-text-secondary">
            {t("undatedNote", { count: undated })}
          </p>
        ) : null}
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-24">
        {groups.map((g) => (
          <section
            key={g.state}
            aria-labelledby={`my-work-${g.state}`}
            className="flex flex-col gap-8"
          >
            <h2
              id={`my-work-${g.state}`}
              className="m-0 flex items-baseline gap-8 text-label-14 font-semibold text-text-primary"
            >
              {t(`groups.${g.state}`)}
              <span className="text-text-12 font-normal text-text-secondary">
                {t("groupCount", { count: g.rows.length })}
              </span>
            </h2>
            {g.rows.length === 0 ? (
              <p className="m-0 text-text-13 text-text-secondary">{t(`groupEmpty.${g.state}`)}</p>
            ) : (
              <RecordList label={t(`groups.${g.state}`)}>
                {g.rows.map((r) => (
                  <RecordRow
                    key={r.key}
                    state={r.state}
                    stateLabel={r.stateLabel}
                    recordKey={r.key}
                    kind={r.kind as RecordKind}
                    title={r.title}
                    next={`${r.project} · ${r.when}`}
                    actionLabel={t("open")}
                    onAction={() => open(r.key)}
                    onOpen={() => open(r.key)}
                  />
                ))}
              </RecordList>
            )}
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-16">
      {views.length > 1 ? switcher : null}
      {body}
    </div>
  );
}
