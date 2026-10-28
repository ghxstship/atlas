"use client";

import type { Cue, CueProgress, RunOfShow } from "@xos/data/show";
import type { ProjectRef, ScopeNodeRef } from "@xos/data/work";
import {
  Button,
  DataTable,
  Dialog,
  Drawer,
  EmptyState,
  IconButton,
  Input,
  PageHeader,
  RecordList,
  RecordRow,
  RunOfShowLive,
  Select,
  Tag,
  TemplateCollection,
  Timeline,
} from "@xos/ui";
import type { Route } from "next";
import { useFormatter, useLocale } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ActionErrorAlert, useAction, useCopy } from "@/components/work/action-ui";
import { formatDay, formatScheduleTime, fromLocalInput, withQuery } from "@/components/work/format";
import { useScheduleView } from "@/components/work/use-schedule-view";
import {
  addCueAction,
  callCueAction,
  createRunAction,
  deleteRunAction,
  moveCueAction,
  removeCueAction,
  updateRunAction,
} from "./actions";
import { CollectionViews } from "@/components/views/collection-views";
import { useLiveRefresh } from "@/components/live/live-refresh";
import { useRowMenu } from "@/components/menus/use-row-menu";

/**
 * Show > Run of show (Section 4.5.5): running orders as a list, table or timeline by show day.
 * The peek holds the cue list editor and live mode, where the stage manager calls cues one by one
 * (journey 15) and everyone following sees each call live, through Realtime (ADR 0044).
 */
export function RunCollection({
  org,
  today,
  title,
  runs,
  total,
  views,
  view,
  q,
  canCreate,
  create,
  peek,
}: {
  org: string;
  /** Today on the org's calendar (A71); an empty timeline starts here. */
  today: string;
  title: string;
  runs: readonly RunOfShow[];
  total: number;
  views: readonly string[];
  view: string;
  q: string;
  canCreate: boolean;
  create: ReactNode;
  peek: ReactNode;
}) {
  const t = useCopy("show");
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [search, setSearch] = useState(q);
  const rowMenu = useRowMenu();
  const go = (changes: Record<string, string | null>) =>
    router.replace(withQuery(pathname, params, changes) as Route, { scroll: false });
  const open = (runId: string) =>
    router.push(withQuery(pathname, params, { peek: runId, live: null }) as Route, {
      scroll: false,
    });
  const progress = (r: RunOfShow) =>
    r.cueCount === 0
      ? t("runs.noCues")
      : t("runs.progress", { called: r.calledCount, total: r.cueCount });

  const header = (
    <PageHeader
      title={title}
      count={runs.length}
      views={
        views.length > 1 ? (
          <CollectionViews
            label={t("runs.views")}
            value={view}
            options={views.map((v) => ({ value: v, label: t(`views.${v}`) }))}
            onChange={(v) => go({ view: v })}
          />
        ) : undefined
      }
      actions={canCreate ? create : undefined}
    />
  );
  const filters = (
    <form
      role="search"
      className="flex items-end gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        go({ q: search.trim() || null });
      }}
    >
      <Input
        id="runs-search"
        type="search"
        label={t("runs.search")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <Button type="submit">{t("runs.searchApply")}</Button>
    </form>
  );

  let body: ReactNode;
  if (total === 0) {
    body = (
      <EmptyState
        icon="ListVideo"
        sentence={canCreate ? t("runs.empty") : t("runs.emptyReadOnly")}
        actionLabel={canCreate ? t("runs.emptyAction") : t("runs.readOnlyAction")}
        onAction={() =>
          canCreate ? go({ create: "1" }) : router.push(`/${org}/schedule/timeline` as Route)
        }
      />
    );
  } else if (runs.length === 0) {
    body = (
      <EmptyState
        icon="SearchX"
        sentence={t("runs.noMatch")}
        actionLabel={t("runs.clear")}
        onAction={() => {
          setSearch("");
          go({ q: null });
        }}
      />
    );
  } else if (view === "table") {
    body = (
      <DataTable
        caption={t("runs.label")}
        columns={[
          { key: "name", label: t("runs.columns.name"), wrap: true },
          { key: "date", label: t("runs.columns.date") },
          { key: "project", label: t("runs.columns.project"), type: "code" },
          { key: "cues", label: t("runs.columns.cues") },
        ]}
        rows={runs.map((r) => ({
          id: r.id,
          name: r.name,
          date: formatDay(r.showDate, locale),
          project: r.projectKey,
          cues: progress(r),
        }))}
        onRowActivate={(row) => open(String(row["id"]))}
        onRowContextMenu={(_row, index, at, cell) => {
          const r = runs[index];
          if (!r) return;
          // A running order has no full page or property that changes in bulk (Section 11.7):
          // its menu opens it, or starts live mode as its peek does once it has cues.
          rowMenu.open(
            {
              id: r.id,
              label: `${r.projectKey} · ${r.name}`,
              open: () => open(r.id),
              ...(r.cueCount > 0
                ? {
                    more: [
                      {
                        label: t("live.start"),
                        icon: "Play" as const,
                        onSelect: () =>
                          router.push(
                            withQuery(pathname, params, { peek: r.id, live: "1" }) as Route,
                            { scroll: false },
                          ),
                      },
                    ],
                  }
                : {}),
            },
            at,
            cell,
          );
        }}
      />
    );
  } else if (view === "timeline") {
    const days = [...new Set(runs.map((r) => r.showDate))].sort();
    const first = days[0] ?? today;
    const last = days.at(-1) ?? first;
    const span = Math.min(
      Math.round(
        (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000,
      ) + 1,
      120,
    );
    const index = (d: string) =>
      Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000);
    body = (
      <div className="min-w-0">
        <Timeline
          label={t("runs.timelineLabel")}
          days={Array.from({ length: span }, (_, i) => {
            const d = new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000);
            return {
              dow: format.dateTime(d, { weekday: "narrow", timeZone: "UTC" }),
              date: d.getUTCDate(),
              weekend: d.getUTCDay() === 0 || d.getUTCDay() === 6,
            };
          })}
          rows={runs.map((r) => ({
            key: r.projectKey,
            title: r.name,
            state:
              r.cueCount > 0 && r.calledCount === r.cueCount
                ? "complete"
                : r.calledCount > 0
                  ? "active"
                  : "scheduled",
            start: Math.min(index(r.showDate), span - 1),
            end: Math.min(index(r.showDate), span - 1),
            milestone: true,
          }))}
        />
      </div>
    );
  } else {
    body = (
      <RecordList label={t("runs.label")}>
        {runs.map((r) => (
          <RecordRow
            key={r.id}
            state={
              r.cueCount > 0 && r.calledCount === r.cueCount
                ? "complete"
                : r.calledCount > 0
                  ? "active"
                  : "scheduled"
            }
            stateLabel={progress(r)}
            recordKey={r.projectKey}
            title={r.name}
            chips={<Tag>{progress(r)}</Tag>}
            next={formatDay(r.showDate, locale)}
            actionLabel={t("runs.open")}
            onAction={() => open(r.id)}
            onOpen={() => open(r.id)}
          />
        ))}
      </RecordList>
    );
  }

  return (
    <TemplateCollection header={header} filters={filters} peek={peek}>
      {body}
      {rowMenu.menu}
    </TemplateCollection>
  );
}

/** The New running order sheet. */
export function CreateRunDialog({
  org,
  projects,
  scopeNodes,
  fixedProjectId,
  open,
}: {
  org: string;
  projects: readonly ProjectRef[];
  scopeNodes: readonly ScopeNodeRef[];
  fixedProjectId?: string;
  open: boolean;
}) {
  const t = useCopy("show");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { pending, error, run, clear } = useAction();
  const [projectId, setProjectId] = useState(fixedProjectId ?? projects[0]?.id ?? "");
  const [name, setName] = useState("");
  const [showDate, setShowDate] = useState("");
  const [scope, setScope] = useState("");
  const nodes = scopeNodes.filter((n) => n.projectId === projectId);
  const setOpen = (value: boolean) => {
    clear();
    router.replace(withQuery(pathname, params, { create: value ? "1" : null }) as Route, {
      scroll: false,
    });
  };
  if (projects.length === 0) return null;
  return (
    <>
      <Button variant="primary" icon="Plus" onClick={() => setOpen(true)}>
        {t("runs.new")}
      </Button>
      {open ? (
        <Drawer
          title={t("runs.newTitle")}
          open
          onOpenChange={(v) => (v ? undefined : setOpen(false))}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t("runs.cancel")}
              </Button>
              <Button
                variant="primary"
                loading={pending}
                disabled={name.trim() === "" || showDate === "" || projectId === ""}
                onClick={() =>
                  run(
                    () =>
                      createRunAction(org, {
                        projectId,
                        name,
                        showDate,
                        scopeNodeId: scope || null,
                      }),
                    (data) =>
                      router.replace(
                        withQuery(pathname, params, { create: null, peek: data.id }) as Route,
                        { scroll: false },
                      ),
                  )
                }
              >
                {t("runs.create")}
              </Button>
            </>
          }
        >
          <ActionErrorAlert error={error} />
          {fixedProjectId || projects.length === 1 ? null : (
            <Select
              id="run-project"
              label={t("runs.project")}
              value={projectId}
              options={projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
              onChange={(e) => setProjectId(e.target.value)}
            />
          )}
          <Input
            id="run-name"
            label={t("runs.name")}
            placeholder={t("runs.nameExample")}
            width="100%"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            id="run-date"
            type="date"
            label={t("runs.showDate")}
            value={showDate}
            onChange={(e) => setShowDate(e.target.value)}
          />
          {nodes.length > 0 ? (
            <Select
              key={projectId}
              id="run-scope"
              label={t("runs.scope")}
              value={scope}
              options={[
                { value: "", label: t("runs.noScope") },
                ...nodes.map((n) => ({ value: n.id, label: n.name })),
              ]}
              onChange={(e) => setScope(e.target.value)}
            />
          ) : null}
        </Drawer>
      ) : null}
    </>
  );
}

/** Show mode follows cue calls within half a second (Section 11.11): small batches, short gaps. */
const SHOW_PACING = { batchMs: 30, minIntervalMs: 200, maxIntervalMs: 1_000 } as const;

/**
 * Follows cue calls live while mounted (ADR 0044): a called cue refreshes the page as soon as
 * Realtime reports it. A 15-second pull covers a dropped channel; it replaced a 2-second poll.
 */
function LiveCues({ runId }: { runId: string }) {
  const router = useRouter();
  useLiveRefresh([{ table: "cues", filter: `run_of_show_id=eq.${runId}` }], SHOW_PACING);
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(timer);
  }, [router]);
  return null;
}

/** Seconds as m:ss, or h:mm:ss past an hour. */
function clock(total: number): string {
  const s = Math.abs(Math.round(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** One running order: details, the cue list editor, and live mode with cue calls. */
export function RunBody({
  org,
  run: runOfShow,
  cues,
  progress,
  live,
  canEdit,
  canCall,
  children,
}: {
  org: string;
  run: RunOfShow;
  cues: readonly Cue[];
  progress: CueProgress;
  live: boolean;
  canEdit: boolean;
  canCall: boolean;
  children?: ReactNode;
}) {
  const t = useCopy("show");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tz = runOfShow.timeZone;
  const details = useAction();
  const cueAction = useAction();
  const calls = useAction();
  const [name, setName] = useState(runOfShow.name);
  const [showDate, setShowDate] = useState(runOfShow.showDate);
  const [label, setLabel] = useState("");
  const [planned, setPlanned] = useState("");
  const [duration, setDuration] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Cue times follow me.time_zone_display and carry their zone abbreviation (Section 15).
  const view = useScheduleView();
  const time = (at: string | null) => formatScheduleTime(at, locale, tz, view, "time");
  const next = progress.next >= 0 ? cues[progress.next] : undefined;
  const current = progress.current >= 0 ? cues[progress.current] : undefined;

  if (live) {
    return (
      <div className="flex flex-col gap-16">
        <LiveCues runId={runOfShow.id} />
        <p className="m-0 text-text-12 text-text-secondary">{t("live.syncing")}</p>
        <ActionErrorAlert error={calls.error} />
        <p role="status" className="m-0 text-heading-16 font-semibold">
          {progress.complete
            ? t("live.complete")
            : current
              ? t("live.current", { label: current.label })
              : t("live.notStarted")}
        </p>
        {next ? (
          <p className="m-0 text-text-14">
            {t("live.standby", { label: next.label })}{" "}
            <span className="text-text-secondary">
              {progress.nextInSeconds === null
                ? t("live.noPlan")
                : progress.nextInSeconds >= 0
                  ? t("live.nextIn", { time: clock(progress.nextInSeconds) })
                  : t("live.nextLate", { time: clock(progress.nextInSeconds) })}
            </span>
          </p>
        ) : null}
        {canCall ? (
          <>
            <RunOfShowLive
              key={`${progress.current}`}
              cues={cues.map((c) => ({
                number: String(c.position),
                time: time(c.plannedAt) ?? "",
                title: c.label,
                ...(c.durationSeconds !== null ? { durationSeconds: c.durationSeconds } : {}),
              }))}
              current={progress.current}
              nextInSeconds={progress.nextInSeconds ?? 0}
              showMode
              onGo={(index) => {
                const cue = cues[index];
                if (cue && !cue.calledAt) calls.run(() => callCueAction(org, cue.id));
              }}
            />
            {next ? (
              <div>
                <Button
                  variant="primary"
                  loading={calls.pending}
                  onClick={() => calls.run(() => callCueAction(org, next.id))}
                >
                  {t("live.callNext")}
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <p className="m-0 text-text-13 text-text-secondary">{t("live.readOnly")}</p>
            <CueList cues={cues} tz={tz} highlight={progress.current} />
          </>
        )}
        <div>
          <Button
            variant="ghost"
            onClick={() =>
              router.replace(withQuery(pathname, params, { live: null }) as Route, {
                scroll: false,
              })
            }
          >
            {t("live.stop")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-24">
      <div className="flex flex-wrap items-center gap-8">
        <Tag>
          {cues.length === 0
            ? t("runs.noCues")
            : t("runs.progress", { called: runOfShow.calledCount, total: cues.length })}
        </Tag>
        <span className="text-text-13 text-text-secondary">
          {formatDay(runOfShow.showDate, locale, { dateStyle: "full" })}
        </span>
      </div>
      {cues.length > 0 ? (
        <div>
          <Button
            variant="primary"
            icon="Play"
            onClick={() =>
              router.replace(withQuery(pathname, params, { live: "1" }) as Route, { scroll: false })
            }
          >
            {t("live.start")}
          </Button>
        </div>
      ) : null}

      <section aria-labelledby={`cues-${runOfShow.id}`} className="flex flex-col gap-8">
        <h3 id={`cues-${runOfShow.id}`} className="m-0 text-label-13 font-semibold">
          {t("cues.title")}
        </h3>
        <ActionErrorAlert error={cueAction.error} />
        {cues.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {canEdit ? t("cues.empty") : t("cues.emptyReadOnly")}
          </p>
        ) : (
          <ol
            aria-label={t("cues.listLabel", { name: runOfShow.name })}
            className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
          >
            {cues.map((c, i) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-8 py-6">
                <span className="flex items-baseline gap-8">
                  <span className="font-mono text-text-12 text-text-secondary">{c.position}</span>
                  <span className="text-text-14">{c.label}</span>
                  <span className="text-text-12 text-text-secondary">
                    {time(c.plannedAt) ?? ""}
                  </span>
                </span>
                <span className="flex items-center gap-4">
                  <span className="text-text-12 text-text-secondary">
                    {c.calledAt
                      ? c.calledByName
                        ? t("cues.called", { time: time(c.calledAt) ?? "", name: c.calledByName })
                        : t("cues.calledBySomeone", { time: time(c.calledAt) ?? "" })
                      : t("cues.notCalled")}
                  </span>
                  {canEdit && !c.calledAt ? (
                    <>
                      <IconButton
                        icon="ArrowUp"
                        label={t("cues.moveUp", { label: c.label })}
                        disabled={i === 0}
                        onClick={() =>
                          cueAction.run(() => moveCueAction(org, runOfShow.id, c.id, "up"))
                        }
                      />
                      <IconButton
                        icon="ArrowDown"
                        label={t("cues.moveDown", { label: c.label })}
                        disabled={i === cues.length - 1}
                        onClick={() =>
                          cueAction.run(() => moveCueAction(org, runOfShow.id, c.id, "down"))
                        }
                      />
                      <IconButton
                        icon="X"
                        label={t("cues.remove", { label: c.label })}
                        onClick={() => cueAction.run(() => removeCueAction(org, c.id))}
                      />
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        )}
        {canEdit ? (
          <form
            className="flex flex-wrap items-end gap-8"
            onSubmit={(e) => {
              e.preventDefault();
              cueAction.run(
                () =>
                  addCueAction(org, {
                    runOfShowId: runOfShow.id,
                    label,
                    plannedAt: planned
                      ? fromLocalInput(`${runOfShow.showDate}T${planned}`, tz)
                      : null,
                    durationSeconds: duration === "" ? null : Number(duration),
                  }),
                () => {
                  setLabel("");
                  setPlanned("");
                  setDuration("");
                },
              );
            }}
          >
            <Input
              id={`cue-label-${runOfShow.id}`}
              label={t("cues.label")}
              placeholder={t("cues.labelExample")}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <Input
              id={`cue-time-${runOfShow.id}`}
              type="time"
              label={t("cues.planned")}
              value={planned}
              onChange={(e) => setPlanned(e.target.value)}
            />
            <Input
              id={`cue-duration-${runOfShow.id}`}
              type="number"
              min={0}
              width={120}
              label={t("cues.duration")}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
            <Button type="submit" disabled={label.trim() === ""} loading={cueAction.pending}>
              {t("cues.add")}
            </Button>
          </form>
        ) : null}
      </section>

      {canEdit ? (
        <form
          aria-label={t("runs.rename")}
          className="flex flex-wrap items-end gap-8"
          onSubmit={(e) => {
            e.preventDefault();
            details.run(() => updateRunAction(org, runOfShow.id, { name, showDate }));
          }}
        >
          <ActionErrorAlert error={details.error} />
          <Input
            id={`run-edit-name-${runOfShow.id}`}
            label={t("runs.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            id={`run-edit-date-${runOfShow.id}`}
            type="date"
            label={t("runs.showDate")}
            value={showDate}
            onChange={(e) => setShowDate(e.target.value)}
          />
          <Button type="submit" loading={details.pending}>
            {t("runs.rename")}
          </Button>
          <Button variant="ghost" icon="Trash2" onClick={() => setConfirmDelete(true)}>
            {t("runs.delete")}
          </Button>
          {confirmDelete ? (
            <Dialog
              title={t("runs.deleteTitle", { name: runOfShow.name })}
              description={t("runs.deleteBody")}
              open
              onOpenChange={(v) => (v ? undefined : setConfirmDelete(false))}
              actions={
                <>
                  <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                    {t("runs.cancel")}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() =>
                      details.run(
                        () => deleteRunAction(org, runOfShow.id),
                        () =>
                          router.replace(withQuery(pathname, params, { peek: null }) as Route, {
                            scroll: false,
                          }),
                      )
                    }
                  >
                    {t("runs.deleteConfirm")}
                  </Button>
                </>
              }
            >
              {null}
            </Dialog>
          ) : null}
        </form>
      ) : null}
      {children}
    </div>
  );
}

function CueList({ cues, tz, highlight }: { cues: readonly Cue[]; tz: string; highlight: number }) {
  const locale = useLocale();
  const view = useScheduleView();
  return (
    <ol className="m-0 flex list-none flex-col p-0">
      {cues.map((c, i) => (
        <li
          key={c.id}
          aria-current={i === highlight ? "true" : undefined}
          className={`flex gap-8 px-8 py-4 ${i === highlight ? "bg-bg-hover font-semibold" : i < highlight ? "text-text-tertiary" : ""}`}
        >
          <span className="font-mono text-text-12">{c.position}</span>
          <span className="text-text-secondary">
            {formatScheduleTime(c.plannedAt, locale, tz, view, "time") ?? ""}
          </span>
          <span>{c.label}</span>
        </li>
      ))}
    </ol>
  );
}

/** The running order peek. */
export function RunPeek({ title, children }: { title: string; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <Drawer
      title={title}
      open
      onOpenChange={(v) => {
        if (!v)
          router.replace(withQuery(pathname, params, { peek: null, live: null }) as Route, {
            scroll: false,
          });
      }}
    >
      {children}
    </Drawer>
  );
}
