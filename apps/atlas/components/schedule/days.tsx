"use client";

import type { DayTemplate } from "@xos/data/day-templates";
import {
  dayTagsByDate,
  dayTypeSlug,
  type ProjectDay,
  type ShowNodeRef,
} from "@xos/data/schedule-days";
import type { ProjectRef, RecordSummary } from "@xos/data/work";
import {
  Button,
  Calendar,
  DataTable,
  EmptyState,
  PageHeader,
  RecordList,
  RecordRow,
  Select,
  TemplateCollection,
} from "@xos/ui";
import type { Route } from "next";
import { useFormatter } from "next-intl";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { CollectionViews } from "@/components/views/collection-views";
import { useCopy } from "@/components/work/action-ui";
import { withQuery } from "@/components/work/format";
import { DayGrid } from "@/components/lazy-ui/day-grid";

// The editor and the template dialogs render nothing until opened, so they load then (ADR 0027).
const DayEditor = dynamic(() => import("./day-editor").then((m) => m.DayEditor));
const DayTemplateApply = dynamic(() =>
  import("./day-template-apply").then((m) => m.DayTemplateApply),
);
const DayTemplateSave = dynamic(() =>
  import("./day-template-apply").then((m) => m.DayTemplateSave),
);

export interface DayGridSource {
  readonly project: ProjectRef;
  readonly day: string;
  readonly records: readonly RecordSummary[];
}

export interface RunRef {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly showDate: string;
}

type DayRef = { readonly key: string; readonly day: string } | null;

/** The text a day type reads as in the locale. */
export function useDayTypeName() {
  const t = useCopy("schedule");
  return (d: Pick<ProjectDay, "dayType" | "label">) =>
    d.label ?? t(`days.types.${dayTypeSlug(d.dayType)}`);
}

/**
 * Schedule > Days (B4, G-38): the projects' day types by date. Each segment reads as text with its icon and a
 * categorical swatch, never by colour alone. Opening a day edits its segments (up to four on a split day), lays its
 * records out as a grid, saves it as a day template or applies one.
 */
export function DaysCollection({
  org,
  title,
  views,
  view,
  month,
  today,
  projectKey,
  projects,
  days,
  venues,
  shows,
  teams,
  templates,
  runs,
  kinds,
  people,
  canWrite,
  canTemplate,
  editing,
  applying,
  saving,
  grid,
}: {
  org: string;
  title: string;
  views: readonly string[];
  view: string;
  month: string;
  today: string;
  projectKey: string;
  projects: readonly ProjectRef[];
  days: readonly ProjectDay[];
  venues: readonly { id: string; name: string; timeZone: string }[];
  shows: readonly ShowNodeRef[];
  teams: readonly { code: string; name: string }[];
  templates: readonly DayTemplate[];
  runs: readonly RunRef[];
  kinds: readonly { kind: string; recordClass: string }[];
  people: readonly { id: string; name: string | null }[];
  canWrite: boolean;
  canTemplate: boolean;
  editing: DayRef;
  applying: DayRef;
  saving: DayRef;
  grid: DayGridSource | null;
}) {
  const t = useCopy("schedule");
  const w = useCopy("work");
  const format = useFormatter();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const name = useDayTypeName();
  const go = (changes: Record<string, string | null>) =>
    router.replace(withQuery(pathname, params, changes) as Route, { scroll: false });
  const open = (d: { projectKey: string; dayOn: string }) =>
    go({ day: `${d.projectKey}:${d.dayOn}` });
  const dateText = (day: string) =>
    format.dateTime(new Date(`${day}T12:00:00Z`), {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  const place = (d: ProjectDay) =>
    d.scopeNodeName ?? d.venueName ?? d.locationText ?? t("days.noPlace");
  const multi = projectKey === "" && new Set(days.map((d) => d.projectId)).size > 1;
  const project = (ref: DayRef) => (ref ? projects.find((p) => p.key === ref.key) : undefined);

  const header = (
    <PageHeader
      title={title}
      count={days.length}
      views={
        <div className="flex flex-wrap items-end gap-8">
          {views.length > 1 ? (
            <CollectionViews
              label={t("days.label")}
              value={view}
              options={views.map((v) => ({ value: v, label: w(`views.${v}`) }))}
              onChange={(v) => go({ view: v })}
            />
          ) : null}
          {projects.length > 1 ? (
            <Select
              id="days-project"
              label={t("days.project")}
              value={projectKey}
              options={[
                { value: "", label: t("days.allProjects") },
                ...projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
              ]}
              onChange={(e) => go({ project: e.target.value || null })}
            />
          ) : null}
        </div>
      }
      actions={
        canWrite && projects.length > 0 ? (
          <Button
            variant="primary"
            icon="CalendarPlus"
            onClick={() =>
              open({ projectKey: projectKey || (projects[0]?.key ?? ""), dayOn: today })
            }
          >
            {t("days.add")}
          </Button>
        ) : undefined
      }
    />
  );

  let body: ReactNode;
  if (days.length === 0) {
    body = (
      <EmptyState
        icon="CalendarDays"
        sentence={canWrite ? t("days.empty") : t("days.emptyReadOnly")}
        actionLabel={canWrite ? t("days.add") : t("days.toTimeline")}
        onAction={() =>
          canWrite && projects[0]
            ? open({ projectKey: projectKey || projects[0].key, dayOn: today })
            : router.push(`/${org}/schedule/timeline` as Route)
        }
      />
    );
  } else if (view === "calendar") {
    const tags = dayTagsByDate(days, name, { prefixKeys: multi });
    const [y, m] = month.split("-").map(Number) as [number, number];
    const shift = (n: number) => {
      const d = new Date(Date.UTC(y, m - 1 + n, 1));
      return d.toISOString().slice(0, 10);
    };
    body = (
      <div className="flex flex-col gap-8">
        <div className="flex gap-6">
          <Button
            size="sm"
            variant="ghost"
            icon="ChevronLeft"
            onClick={() => go({ month: shift(-1) })}
          >
            {t("days.previousMonth")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="ChevronRight"
            onClick={() => go({ month: shift(1) })}
          >
            {t("days.nextMonth")}
          </Button>
        </div>
        <Calendar
          month={month}
          today={today}
          events={days.map((d) => ({
            id: d.id,
            date: d.dayOn,
            label: multi ? `${d.projectKey} ${name(d)}` : name(d),
            state: "scheduled" as const,
          }))}
          days={[...tags].map(([date, value]) => ({
            date,
            tags: [
              ...value.tags.map((tag) => ({
                label: tag.label,
                category: tag.category,
                icon: tag.icon,
              })),
              ...(value.more > 0
                ? [{ label: t("days.more", { n: value.more }), category: 7 as const }]
                : []),
            ],
          }))}
          onEventSelect={(e) => {
            const d = days.find((x) => x.id === e.id);
            if (d) open(d);
          }}
        />
      </div>
    );
  } else if (view === "list") {
    body = (
      <RecordList label={t("days.label")}>
        {days.map((d) => (
          <RecordRow
            key={d.id}
            state="scheduled"
            stateLabel={name(d)}
            recordKey={d.projectKey}
            title={`${dateText(d.dayOn)} · ${name(d)}`}
            next={place(d)}
            actionLabel={t("days.open")}
            onAction={() => open(d)}
            onOpen={() => open(d)}
          />
        ))}
      </RecordList>
    );
  } else {
    body = (
      <DataTable
        caption={t("days.label")}
        columns={[
          { key: "date", label: t("days.columns.date") },
          { key: "project", label: t("days.columns.project"), type: "code" },
          { key: "type", label: t("days.columns.type") },
          { key: "place", label: t("days.columns.place"), wrap: true },
          { key: "zone", label: t("days.columns.zone") },
          { key: "team", label: t("days.columns.team") },
        ]}
        rows={days.map((d) => ({
          id: d.id,
          date: dateText(d.dayOn),
          project: d.projectKey,
          type: name(d),
          place: place(d),
          zone: d.timeZone.replaceAll("_", " "),
          team: d.teamCode
            ? (teams.find((x) => x.code === d.teamCode)?.name ?? d.teamCode)
            : t("days.everyone"),
        }))}
        onRowActivate={(row) => {
          const d = days.find((x) => x.id === row["id"]);
          if (d) open(d);
        }}
      />
    );
  }

  const editProject = project(editing);
  const applyProject = project(applying);
  const saveProject = project(saving);
  return (
    <TemplateCollection header={header} peek={null}>
      {body}
      {editing && editProject ? (
        <DayEditor
          org={org}
          project={editProject}
          projects={projects}
          day={editing.day}
          segments={days.filter((d) => d.projectId === editProject.id && d.dayOn === editing.day)}
          venues={venues}
          shows={shows.filter((s) => s.projectId === editProject.id)}
          teams={teams}
          canWrite={canWrite}
          canTemplate={canTemplate && templates.length > 0}
          canSaveTemplate={canTemplate}
          onClose={() => go({ day: null })}
          onOpen={(changes) => go({ day: null, ...changes })}
        />
      ) : null}
      {grid ? (
        <DayGrid
          org={org}
          source={grid}
          kinds={kinds}
          people={people}
          canWrite={canWrite}
          onClose={() => go({ grid: null })}
        />
      ) : null}
      {applying && applyProject ? (
        <DayTemplateApply
          org={org}
          project={applyProject}
          day={applying.day}
          templates={templates}
          runs={runs.filter((r) => r.projectId === applyProject.id && r.showDate === applying.day)}
          onClose={() => go({ apply: null })}
        />
      ) : null}
      {saving && saveProject ? (
        <DayTemplateSave
          org={org}
          project={saveProject}
          day={saving.day}
          runs={runs.filter((r) => r.projectId === saveProject.id && r.showDate === saving.day)}
          onClose={() => go({ save: null })}
        />
      ) : null}
    </TemplateCollection>
  );
}
