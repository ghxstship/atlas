"use client";

import {
  callLines,
  CUE_CALL_KINDS,
  CUE_CALL_SLUGS,
  type Cue,
  type CueCall,
  type CueCallKind,
  type CueEngagement,
  type CueProgress,
  type RunOfShow,
} from "@xos/data/show";
import type { ProjectRef, ScopeNodeRef } from "@xos/data/work";
import {
  Button,
  Checkbox,
  DataTable,
  Dialog,
  Drawer,
  EmptyState,
  IconButton,
  Input,
  PageHeader,
  RecordList,
  RecordRow,
  Select,
  Tag,
  TemplateCollection,
  Timeline,
} from "@xos/ui";
import type { Route } from "next";
import dynamic from "next/dynamic";
import { useFormatter, useLocale } from "next-intl";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ActionErrorAlert, useAction, useCopy } from "@/components/work/action-ui";
import {
  formatDay,
  formatScheduleTime,
  formatStartTime,
  fromLocalInput,
  toLocalInput,
  withQuery,
} from "@/components/work/format";
import { useScheduleView } from "@/components/work/use-schedule-view";
import {
  addCueAction,
  createRunAction,
  deleteRunAction,
  linkCueAction,
  moveCueAction,
  removeCueAction,
  unlinkCueAction,
  updateRunAction,
} from "./actions";
import { CollectionViews } from "@/components/views/collection-views";
import { useLiveRefresh } from "@/components/live/live-refresh";
import { useRowMenu } from "@/components/menus/use-row-menu";

// Shift the cues still to come (P8), for people who edit the run of show; loads on demand.
const CueShift = dynamic(() => import("./cue-shift").then((m) => m.CueShift));
// The showcaller console and the inline cue editor load when opened, so the route keeps its weight.
const ShowcallerConsole = dynamic(() =>
  import("./showcaller-console").then((m) => m.ShowcallerConsole),
);
const CueEditor = dynamic(() => import("./cue-editor").then((m) => m.CueEditor));
const MoveCueDialog = dynamic(() => import("./cue-editor").then((m) => m.MoveCueDialog));

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

/**
 * A cue's Set for control in edit mode: each linked artist with an unlink button (a back-to-back set
 * links two), then a select of the project's other Artist engagements. Gateway Set Times shows the
 * linked cue to each artist (Section 4.4.4).
 */
function SetFor({
  org,
  cue,
  links,
  artists,
  action,
}: {
  org: string;
  cue: Cue;
  links: readonly CueEngagement[];
  artists: readonly { value: string; label: string }[];
  action: ReturnType<typeof useAction>;
}) {
  const t = useCopy("show");
  const unlinked = artists.filter((a) => !links.some((l) => l.engagementId === a.value));
  return (
    <>
      {links.map((link) => (
        <span key={link.id} className="flex items-center gap-4 text-text-12">
          {t("cues.setForName", { name: link.personName ?? t("cues.setForNone") })}
          <IconButton
            icon="X"
            label={t("cues.unlink", {
              name: link.personName ?? t("cues.setForNone"),
              label: cue.label,
            })}
            onClick={() => action.run(() => unlinkCueAction(org, link.id))}
          />
        </span>
      ))}
      {unlinked.length > 0 ? (
        <Select
          id={`set-for-${cue.id}`}
          label={t("cues.setFor")}
          value=""
          options={[{ value: "", label: t("cues.setForNone") }, ...unlinked]}
          onChange={(e) => {
            const engagementId = e.target.value;
            if (engagementId) action.run(() => linkCueAction(org, cue.id, engagementId));
          }}
        />
      ) : null}
    </>
  );
}

/** Seconds as m:ss, or h:mm:ss past an hour. */
function clock(total: number): string {
  const s = Math.abs(Math.round(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** A cue's planned time, or "TBC · est. <time>" while it is to be confirmed (G-40). */
function useCueTime(tz: string): (cue: Cue) => string {
  const t = useCopy("show");
  const locale = useLocale();
  const view = useScheduleView();
  return (cue) =>
    formatStartTime(cue.plannedAt, cue.startTbc, locale, tz, view, "time", (time) =>
      t("cues.tbcEstimate", { time }),
    ) ?? "";
}

/**
 * A cue's department calls as tagged lines ("Lighting · LX 14 GO"), in enum order (G-74). With a
 * department chosen only its line shows, or "No Lighting call".
 */
function CallLines({
  calls,
  department,
}: {
  calls: readonly CueCall[];
  department: CueCallKind | null;
}) {
  const t = useCopy("show");
  const name = (k: CueCallKind) => t(`cues.departments.${CUE_CALL_SLUGS[k]}`);
  const lines = callLines(calls, department);
  if (department !== null && lines.length === 0) {
    return (
      <span className="text-text-12 text-text-tertiary">
        {t("cues.noCall", { department: name(department) })}
      </span>
    );
  }
  if (lines.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {lines.map((line) => (
        <li
          key={line.kind}
          className={
            department === null
              ? "text-text-12 text-text-secondary"
              : "text-text-13 font-semibold text-accent-text"
          }
        >
          {t("cues.callLine", { department: name(line.kind), instruction: line.instruction })}
        </li>
      ))}
    </ul>
  );
}

/** The Department select (All plus the five), held in the URL as `dept=<slug>`. */
function DepartmentFilter({
  runId,
  department,
}: {
  runId: string;
  department: CueCallKind | null;
}) {
  const t = useCopy("show");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <Select
      id={`cue-department-${runId}`}
      label={t("cues.department")}
      value={department === null ? "" : CUE_CALL_SLUGS[department]}
      options={[
        { value: "", label: t("cues.allDepartments") },
        ...CUE_CALL_KINDS.map((k) => ({
          value: CUE_CALL_SLUGS[k],
          label: t(`cues.departments.${CUE_CALL_SLUGS[k]}`),
        })),
      ]}
      onChange={(e) =>
        router.replace(withQuery(pathname, params, { dept: e.target.value || null }) as Route, {
          scroll: false,
        })
      }
    />
  );
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
  setTimes = [],
  artists = [],
  calls = [],
  department = null,
  children,
}: {
  org: string;
  run: RunOfShow;
  cues: readonly Cue[];
  progress: CueProgress;
  live: boolean;
  canEdit: boolean;
  canCall: boolean;
  /** Cues marked as an artist's set time (app.engagement_cues), for the Set for control. */
  setTimes?: readonly CueEngagement[];
  /** The run's project's Artist engagements a cue can be set for. */
  artists?: readonly { value: string; label: string }[];
  /** The running order's department calls (app.cue_calls). */
  calls?: readonly CueCall[];
  /** The department chosen in the URL (`dept=`), or null for every department. */
  department?: CueCallKind | null;
  children?: ReactNode;
}) {
  const t = useCopy("show");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const rowMenu = useRowMenu();
  const tz = runOfShow.timeZone;
  const details = useAction();
  const cueAction = useAction();
  const [name, setName] = useState(runOfShow.name);
  const [showDate, setShowDate] = useState(runOfShow.showDate);
  const [curfew, setCurfew] = useState(toLocalInput(runOfShow.curfewAt, tz));
  const [label, setLabel] = useState("");
  const [planned, setPlanned] = useState("");
  const [plannedTbc, setPlannedTbc] = useState(false);
  const [duration, setDuration] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [moving, setMoving] = useState<Cue | null>(null);
  // Cue times follow me.time_zone_display and carry their zone abbreviation (Section 15).
  const view = useScheduleView();
  const time = (at: string | null) => formatScheduleTime(at, locale, tz, view, "time");
  const cueTime = useCueTime(tz);
  const next = progress.next >= 0 ? cues[progress.next] : undefined;
  const current = progress.current >= 0 ? cues[progress.current] : undefined;
  const callsOf = (cueId: string) => calls.filter((c) => c.cueId === cueId);
  const lastCalled = cues.reduce((last, c, i) => (c.calledAt ? i : last), -1);
  const setDepartment = (kind: CueCallKind | null) =>
    router.replace(
      withQuery(pathname, params, { dept: kind === null ? null : CUE_CALL_SLUGS[kind] }) as Route,
      { scroll: false },
    );

  if (live) {
    return (
      <div className="flex flex-col gap-16">
        <LiveCues runId={runOfShow.id} />
        <p className="m-0 text-text-12 text-text-secondary">{t("live.syncing")}</p>
        {/* The current and standby lines are the only live regions; each changes once per call. */}
        <p role="status" className="m-0 text-heading-16 font-semibold">
          {progress.complete
            ? progress.skipped.length > 0
              ? t("live.completeSkipped", { count: progress.skipped.length })
              : t("live.complete")
            : current
              ? t("live.current", { label: current.label })
              : t("live.notStarted")}
        </p>
        {next ? (
          <p className="m-0 flex flex-wrap items-baseline gap-x-8 text-text-14">
            <span role="status">
              {progress.standby
                ? t("live.standby", { label: next.label })
                : t("live.next", { label: next.label })}
            </span>
            <span className="text-text-secondary">
              {progress.nextInSeconds === null || next.startTbc
                ? next.startTbc
                  ? cueTime(next)
                  : t("live.noPlan")
                : progress.nextInSeconds >= 0
                  ? t("live.nextIn", { time: clock(progress.nextInSeconds) })
                  : t("live.nextLate", { time: clock(progress.nextInSeconds) })}
            </span>
          </p>
        ) : null}
        {canCall ? (
          <ShowcallerConsole
            org={org}
            run={runOfShow}
            cues={cues}
            calls={calls}
            department={department}
            onDepartment={setDepartment}
          />
        ) : (
          <>
            <p className="m-0 text-text-13 text-text-secondary">{t("live.readOnly")}</p>
            <DepartmentFilter runId={runOfShow.id} department={department} />
            <CueList
              cues={cues}
              tz={tz}
              progress={progress}
              calls={calls}
              department={department}
            />
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
        {cues.length > 0 ? <DepartmentFilter runId={runOfShow.id} department={department} /> : null}
        {cues.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {canEdit ? t("cues.empty") : t("cues.emptyReadOnly")}
          </p>
        ) : (
          <ol
            aria-label={t("cues.listLabel", { name: runOfShow.name })}
            className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
          >
            {cues.map((c, i) => {
              const own = callsOf(c.id);
              const marked = department !== null && own.some((k) => k.kind === department);
              const movable = canEdit && !c.calledAt;
              if (editing === c.id) {
                return (
                  <li key={c.id} className="flex py-6">
                    <CueEditor
                      org={org}
                      run={runOfShow}
                      cue={c}
                      calls={own}
                      onClose={() => setEditing(null)}
                    />
                  </li>
                );
              }
              return (
                <li
                  key={c.id}
                  className={`flex flex-wrap items-center justify-between gap-8 py-6 ${marked ? "border-s-2 border-s-accent ps-8" : ""}`}
                  onContextMenu={
                    movable
                      ? (e) => {
                          e.preventDefault();
                          rowMenu.open(
                            {
                              id: c.id,
                              label: c.label,
                              more: [
                                {
                                  label: t("cues.moveToMenu"),
                                  icon: "ChevronsUpDown" as const,
                                  onSelect: () => setMoving(c),
                                },
                              ],
                            },
                            { x: e.clientX, y: e.clientY },
                            e.currentTarget,
                          );
                        }
                      : undefined
                  }
                >
                  <span className="flex flex-col gap-2">
                    <span className="flex items-baseline gap-8">
                      <span className="font-mono text-text-12 text-text-secondary">
                        {c.position}
                      </span>
                      <span className="text-text-14">{c.label}</span>
                      <span className="text-text-12 text-text-secondary">{cueTime(c)}</span>
                      {marked ? (
                        <span className="sr-only">
                          {t("cues.hasCall", {
                            department: t(`cues.departments.${CUE_CALL_SLUGS[department]}`),
                          })}
                        </span>
                      ) : null}
                    </span>
                    <CallLines calls={own} department={department} />
                  </span>
                  <span className="flex items-center gap-4">
                    {canEdit ? (
                      <SetFor
                        org={org}
                        cue={c}
                        links={setTimes.filter((s) => s.cueId === c.id)}
                        artists={artists}
                        action={cueAction}
                      />
                    ) : null}
                    <span className="text-text-12 text-text-secondary">
                      {c.calledAt
                        ? c.calledByName
                          ? t("cues.called", { time: time(c.calledAt) ?? "", name: c.calledByName })
                          : t("cues.calledBySomeone", { time: time(c.calledAt) ?? "" })
                        : t("cues.notCalled")}
                    </span>
                    {canEdit ? (
                      <IconButton
                        icon="Pencil"
                        label={t("cues.edit", { label: c.label })}
                        onClick={() => setEditing(c.id)}
                      />
                    ) : null}
                    {movable ? (
                      <>
                        <IconButton
                          icon="ArrowUp"
                          label={t("cues.moveUp", { label: c.label })}
                          disabled={i === 0 || i - 1 <= lastCalled}
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
                          icon="ChevronsUpDown"
                          label={t("cues.moveTo", { label: c.label })}
                          onClick={() => setMoving(c)}
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
              );
            })}
          </ol>
        )}
        {canEdit && cues.some((c) => !c.calledAt && c.plannedAt) ? (
          <CueShift
            org={org}
            runId={runOfShow.id}
            cues={cues}
            label={(c) => time(c.plannedAt) ?? ""}
          />
        ) : null}
        {moving ? (
          <MoveCueDialog
            org={org}
            runId={runOfShow.id}
            cues={cues}
            cue={moving}
            onClose={() => setMoving(null)}
          />
        ) : null}
        {rowMenu.menu}
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
                    startTbc: planned !== "" && plannedTbc,
                  }),
                () => {
                  setLabel("");
                  setPlanned("");
                  setPlannedTbc(false);
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
            <Checkbox
              label={t("cues.tbc")}
              checked={planned !== "" && plannedTbc}
              disabled={planned === ""}
              onChange={(e) => setPlannedTbc(e.target.checked)}
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
            details.run(() =>
              updateRunAction(org, runOfShow.id, {
                name,
                showDate,
                curfewAt: fromLocalInput(curfew, tz),
              }),
            );
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
          <Input
            id={`run-edit-curfew-${runOfShow.id}`}
            type="datetime-local"
            label={t("runs.curfew")}
            value={curfew}
            onChange={(e) => setCurfew(e.target.value)}
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

/**
 * What a follower without show.cue.call sees in live mode: the cues with the current one marked, the
 * standby cue, cues the caller jumped past, TBC times and the department lines.
 */
function CueList({
  cues,
  tz,
  progress,
  calls,
  department,
}: {
  cues: readonly Cue[];
  tz: string;
  progress: CueProgress;
  calls: readonly CueCall[];
  department: CueCallKind | null;
}) {
  const t = useCopy("show");
  const cueTime = useCueTime(tz);
  const highlight = progress.current;
  return (
    <ol className="m-0 flex list-none flex-col p-0">
      {cues.map((c, i) => (
        <li
          key={c.id}
          aria-current={i === highlight ? "true" : undefined}
          className={`flex flex-wrap items-baseline gap-8 px-8 py-4 ${i === highlight ? "bg-bg-hover font-semibold" : i < highlight ? "text-text-tertiary" : ""}`}
        >
          <span className="font-mono text-text-12">{c.position}</span>
          <span className="text-text-secondary">{cueTime(c)}</span>
          <span>{c.label}</span>
          {progress.skipped.includes(i) ? <Tag>{t("cues.skipped")}</Tag> : null}
          {c.calledAt === null && c.standbyAt ? (
            <Tag tone="warning">{t("cues.onStandby")}</Tag>
          ) : null}
          <span className="basis-full">
            <CallLines calls={calls.filter((k) => k.cueId === c.id)} department={department} />
          </span>
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
