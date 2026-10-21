"use client";

import type { GateReadiness, HomeRecord } from "@xos/data/home";
import type { ProjectSummary } from "@xos/data/projects";
import {
  Button,
  Chart,
  DataTable,
  EmptyState,
  RecordList,
  RecordRow,
  Tag,
  type RecordKind,
  type RecordState,
} from "@xos/ui";
import type { Route } from "next";
import { useFormatter, useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Alert } from "@/lib/home/data";
import { enumKey, phaseCode } from "@/lib/projects/format";
import { CollectionViews } from "@/components/views/collection-views";
import { useAlertText } from "./alert-text";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** A record state as the design system's state icon (the nine canon states). */
function recordState(state: string): RecordState {
  return state.toLowerCase().replace(" ", "-") as RecordState;
}

/** The catalog label of a record state. */
function useRecordStateLabel() {
  const t = useTranslations("projects.recordStates") as unknown as Translate;
  return (state: string) => t(enumKey(state));
}

function useViewSwitch() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (v: string) => {
    const q = new URLSearchParams(params.toString());
    q.set("view", v);
    router.replace(`${pathname}?${q.toString()}` as Route);
  };
}

function ViewSwitch({ views, view }: { views: readonly string[]; view: string }) {
  const t = useTranslations("projects.views") as unknown as Translate;
  const setView = useViewSwitch();
  if (views.length < 2) return null;
  return (
    <CollectionViews
      label={t("label")}
      value={view}
      options={views.map((v) => ({ value: v, label: t(v) }))}
      onChange={setView}
    />
  );
}

function Empty({ sentence, action, href }: { sentence: string; action: string; href: string }) {
  const router = useRouter();
  return (
    <EmptyState
      icon="Sun"
      sentence={sentence}
      actionLabel={action}
      onAction={() => router.push(href as Route)}
    />
  );
}

// Today --------------------------------------------------------------------------------------------

/** Home > Today: the person's records due or running today and projects that start or end today. */
export function TodayView({
  org,
  records,
  projects,
  views,
  view,
  projectsHref,
}: {
  org: string;
  records: readonly HomeRecord[];
  projects: readonly {
    readonly key: string;
    readonly name: string;
    readonly edge: "starts" | "ends";
  }[];
  views: readonly string[];
  view: string;
  projectsHref: string;
}) {
  const t = useTranslations("home.today");
  const stateLabel = useRecordStateLabel();
  const format = useFormatter();
  const router = useRouter();
  if (records.length === 0 && projects.length === 0) {
    return <Empty sentence={t("empty")} action={t("emptyAction")} href={projectsHref} />;
  }
  const time = (r: HomeRecord) =>
    r.dueAt
      ? t("due", { time: format.dateTime(new Date(r.dueAt), { timeStyle: "short" }) })
      : t("runs");
  const open = (key: string | null) => {
    if (key) router.push(`/${org}/p/${key}/overview` as Route);
  };
  return (
    <div className="flex flex-col gap-12">
      <ViewSwitch views={views} view={view} />
      {projects.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-8 p-0">
          {projects.map((p) => (
            <li key={`${p.key}-${p.edge}`}>
              <Button size="sm" variant="secondary" onClick={() => open(p.key)}>
                {t(p.edge, { key: p.key })}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {view === "list" ? (
        <RecordList label={t("label")}>
          {records.map((r) => (
            <RecordRow
              key={r.id}
              state={recordState(r.state)}
              stateLabel={stateLabel(r.state)}
              recordKey={r.key ?? ""}
              kind={r.kind as RecordKind}
              title={r.title}
              next={time(r)}
              actionLabel={t("open")}
              onAction={() => open(r.projectKey)}
              onOpen={() => open(r.projectKey)}
            />
          ))}
        </RecordList>
      ) : (
        <ol aria-label={t("label")} className="m-0 flex list-none flex-col gap-8 p-0">
          {records.map((r) => (
            <li
              key={r.id}
              className="grid grid-cols-[var(--ui-props-label)_minmax(0,1fr)] gap-12 rounded-card border border-border-subtle bg-bg-surface p-12"
            >
              <span className="text-text-12 text-text-secondary tabular-nums">{time(r)}</span>
              <span className="flex flex-col gap-2">
                <span className="text-text-14 text-text-primary">
                  <span className="font-mono text-text-12 text-text-secondary">{r.key}</span>{" "}
                  {r.title}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {r.kind} · {stateLabel(r.state)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// Gate readiness -----------------------------------------------------------------------------------

/** Home > Gate readiness: every live project's current gate as a table, a matrix or a chart. */
export function ReadinessView({
  org,
  readiness,
  totalGates,
  views,
  view,
  projectsHref,
}: {
  org: string;
  readiness: readonly GateReadiness[];
  totalGates: number;
  views: readonly string[];
  view: string;
  projectsHref: string;
}) {
  const t = useTranslations("home.readiness");
  const p = useTranslations("projects") as unknown as Translate;
  const router = useRouter();
  if (readiness.length === 0) {
    return <Empty sentence={t("empty")} action={t("emptyAction")} href={projectsHref} />;
  }
  const phase = (r: GateReadiness) =>
    r.phase
      ? `${p("gates.gate", { gate: r.phase.gate })} · ${p(`phases.${phaseCode(r.phase.code)}`)}`
      : "";
  return (
    <div className="flex flex-col gap-12">
      <ViewSwitch views={views} view={view} />
      {view === "chart" ? (
        <Chart
          type="bar"
          title={t("chartTitle")}
          subtitle={t("chartSubtitle")}
          categoryLabel={t("project")}
          categories={readiness.map((r) => r.project.key)}
          series={[
            {
              name: t("seriesMet"),
              values: readiness.map((r) => (r.closed ? null : r.blockingMet)),
            },
            {
              name: t("seriesOpen"),
              values: readiness.map((r) => (r.closed ? null : r.blockingTotal - r.blockingMet)),
            },
          ]}
        />
      ) : view === "matrix" ? (
        <div role="region" aria-label={t("matrixCaption")} tabIndex={0} className="overflow-x-auto">
          <table className="w-full border-collapse text-text-13">
            <caption className="mb-8 text-start text-label-13 font-semibold">
              {t("matrixCaption")}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="border-b border-border-subtle p-6 text-start">
                  {t("project")}
                </th>
                {Array.from({ length: totalGates }, (_, i) => (
                  <th key={i} scope="col" className="border-b border-border-subtle p-6 text-center">
                    {p("gates.gate", { gate: i + 1 })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {readiness.map((r) => (
                <tr key={r.project.id}>
                  <th
                    scope="row"
                    className="border-b border-border-subtle p-6 text-start font-normal"
                  >
                    <button
                      type="button"
                      className="cursor-pointer border-0 bg-transparent p-0 text-accent-text underline"
                      onClick={() => router.push(`/${org}/p/${r.project.key}/gates` as Route)}
                    >
                      {r.project.key}
                    </button>{" "}
                    {r.project.name}
                  </th>
                  {Array.from({ length: totalGates }, (_, i) => {
                    const gate = i + 1;
                    const current = r.phase?.gate ?? 0;
                    const cell =
                      r.closed || gate < current
                        ? t("passed")
                        : gate === current
                          ? t("current", { met: r.blockingMet, total: r.blockingTotal })
                          : t("upcoming");
                    return (
                      <td
                        key={gate}
                        className={`border-b border-border-subtle p-6 text-center ${
                          gate === current && !r.closed
                            ? "font-semibold text-text-primary"
                            : "text-text-secondary"
                        }`}
                      >
                        {cell}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <DataTable
          caption={t("caption")}
          columns={[
            { key: "key", label: p("fields.key"), type: "code", width: 88 },
            { key: "name", label: t("project"), wrap: true },
            { key: "phase", label: t("phase"), width: 180 },
            { key: "met", label: t("blocking"), width: 200 },
            { key: "unmet", label: t("unmet"), wrap: true },
          ]}
          rows={readiness.map((r) => ({
            id: r.project.id,
            key: r.project.key,
            name: r.project.name,
            phase: r.closed ? t("closed") : phase(r),
            met: r.closed ? t("closed") : t("met", { met: r.blockingMet, total: r.blockingTotal }),
            unmet:
              r.unmet.length > 0
                ? r.unmet.map((c) => `${c.statement.replace(/\.$/, "")} (${c.id})`).join("; ")
                : t("none"),
          }))}
          onRowActivate={(row) => router.push(`/${org}/p/${String(row["key"])}/gates` as Route)}
        />
      )}
    </div>
  );
}

// Alerts -------------------------------------------------------------------------------------------

/** Home > Alerts: what needs attention, highest severity first, as a list or an inbox. */
export function AlertsView({
  org,
  alerts,
  views,
  view,
  projectsHref,
}: {
  org: string;
  alerts: readonly Alert[];
  views: readonly string[];
  view: string;
  projectsHref: string;
}) {
  const t = useTranslations("home.alerts");
  const text = useAlertText();
  const router = useRouter();
  if (alerts.length === 0) {
    return <Empty sentence={t("empty")} action={t("emptyAction")} href={projectsHref} />;
  }
  const open = (a: Alert) => {
    if (a.projectKey) router.push(`/${org}/p/${a.projectKey}/${a.tab}` as Route);
  };
  return (
    <div className="flex flex-col gap-12">
      <ViewSwitch views={views} view={view} />
      <ul
        aria-label={t("label")}
        className={`m-0 flex list-none flex-col p-0 ${view === "inbox" ? "gap-8" : "divide-y divide-border-subtle"}`}
      >
        {alerts.map((a) => (
          <li
            key={a.id}
            className={`flex flex-wrap items-center justify-between gap-8 ${
              view === "inbox"
                ? "rounded-card border border-border-subtle bg-bg-surface p-12"
                : "py-8"
            }`}
          >
            <span className="flex min-w-0 items-center gap-8">
              <Tag tone={a.severity === "high" ? "danger" : "warning"}>
                {a.severity === "high" ? t("high") : t("medium")}
              </Tag>
              <span className="text-text-14 text-text-primary">{text(a)}</span>
            </span>
            {a.projectKey ? (
              <Button size="sm" variant="secondary" onClick={() => open(a)}>
                {t("open")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Recent -------------------------------------------------------------------------------------------

/** Home > Recent: records the person changed, and projects changed recently. */
export function RecentView({
  org,
  records,
  projects,
  views,
  view,
  projectsHref,
}: {
  org: string;
  records: readonly HomeRecord[];
  projects: readonly ProjectSummary[];
  views: readonly string[];
  view: string;
  projectsHref: string;
}) {
  const t = useTranslations("home.recent");
  const stateLabel = useRecordStateLabel();
  const format = useFormatter();
  const router = useRouter();
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const open = (key: string | null) => {
    if (key) router.push(`/${org}/p/${key}/overview` as Route);
  };
  return (
    <div className="flex flex-col gap-16">
      <ViewSwitch views={views} view={view} />
      {records.length === 0 ? (
        <Empty sentence={t("empty")} action={t("emptyAction")} href={projectsHref} />
      ) : view === "table" ? (
        <DataTable
          caption={t("caption")}
          columns={[
            { key: "key", label: t("key"), type: "code", width: 110 },
            { key: "title", label: t("record"), wrap: true },
            { key: "kind", label: t("kind"), width: 140 },
            { key: "state", label: t("state"), type: "state", width: 140 },
            { key: "updated", label: t("updated"), width: 200 },
          ]}
          rows={records.map((r) => ({
            id: r.id,
            key: r.key ?? "",
            title: r.title,
            kind: r.kind,
            state: { state: recordState(r.state), label: stateLabel(r.state) },
            updated: when(r.updatedAt),
            project: r.projectKey,
          }))}
          onRowActivate={(row) => open(typeof row["project"] === "string" ? row["project"] : null)}
        />
      ) : (
        <RecordList label={t("caption")}>
          {records.map((r) => (
            <RecordRow
              key={r.id}
              state={recordState(r.state)}
              stateLabel={stateLabel(r.state)}
              recordKey={r.key ?? ""}
              kind={r.kind as RecordKind}
              title={r.title}
              next={when(r.updatedAt)}
              onOpen={() => open(r.projectKey)}
            />
          ))}
        </RecordList>
      )}
      {projects.length > 0 ? (
        <section aria-labelledby="recent-projects" className="flex flex-col gap-8">
          <h2 id="recent-projects" className="m-0 text-heading-16 font-semibold">
            {t("projectsTitle")}
          </h2>
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {projects.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
                <button
                  type="button"
                  className="cursor-pointer border-0 bg-transparent p-0 text-start text-text-14 text-accent-text underline"
                  onClick={() => open(p.key)}
                >
                  {p.key} {p.name}
                </button>
                <span className="text-text-12 text-text-secondary">{when(p.updatedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
