"use client";

import { isOver, workloadGrid, workloadStep, type Workload } from "@xos/data/workload";
import type { ProjectRef } from "@xos/data/work";
import {
  Button,
  DataTable,
  Drawer,
  EmptyState,
  Heatmap,
  PageHeader,
  PropertyList,
  Select,
  TemplateCollection,
} from "@xos/ui";
import { addDays } from "@xos/ui/quick-add";
import type { Route } from "next";
import { useFormatter } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { CollectionViews } from "@/components/views/collection-views";
import { useCopy } from "@/components/work/action-ui";
import { withQuery } from "@/components/work/format";

/**
 * Schedule > Workload (B4, G-45): people against the week's days. Every cell shows its hours as text beside its
 * tint, and a day over the org's limit carries an icon and "Over {limit} h", so the tint is never the only signal.
 * The table view lists the same values. A cell opens its detail: shift hours, task hours and unestimated tasks.
 */
export function WorkloadCollection({
  org,
  title,
  views,
  view,
  from,
  to,
  projectKey,
  projects,
  workload,
  cell,
}: {
  org: string;
  title: string;
  views: readonly string[];
  view: string;
  from: string;
  to: string;
  projectKey: string;
  projects: readonly ProjectRef[];
  workload: Workload;
  cell: string | null;
}) {
  const t = useCopy("schedule");
  const w = useCopy("work");
  const format = useFormatter();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (changes: Record<string, string | null>) =>
    router.replace(withQuery(pathname, params, changes) as Route, { scroll: false });
  const grid = workloadGrid(workload, from, to);
  const noon = (day: string) => new Date(`${day}T12:00:00Z`);
  const short = (day: string) =>
    format.dateTime(noon(day), { weekday: "short", day: "numeric", timeZone: "UTC" });
  const long = (day: string) =>
    format.dateTime(noon(day), { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  const hours = (n: number) =>
    t("workload.hours", { n: format.number(n, { maximumFractionDigits: 2 }) });
  const over = t("workload.over", { limit: workload.limit });
  const byKey = new Map(workload.cells.map((c) => [`${c.personId}:${c.day}`, c]));
  const name = (id: string) => grid.people.find((p) => p.id === id)?.name ?? t("workload.unnamed");

  const header = (
    <PageHeader
      title={title}
      count={grid.people.length}
      views={
        <div className="flex flex-wrap items-end gap-8">
          {views.length > 1 ? (
            <CollectionViews
              label={t("workload.label")}
              value={view}
              options={views.map((v) => ({ value: v, label: w(`views.${v}`) }))}
              onChange={(v) => go({ view: v })}
            />
          ) : null}
          {projects.length > 1 ? (
            <Select
              id="workload-project"
              label={t("workload.project")}
              value={projectKey}
              options={[
                { value: "", label: t("workload.allProjects") },
                ...projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
              ]}
              onChange={(e) => go({ project: e.target.value || null })}
            />
          ) : null}
          <div
            className="flex gap-6"
            role="group"
            aria-label={t("workload.week", { from: long(from), to: long(to) })}
          >
            <Button
              size="sm"
              variant="ghost"
              icon="ChevronLeft"
              onClick={() => go({ week: addDays(from, -7) })}
            >
              {t("workload.previousWeek")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon="ChevronRight"
              onClick={() => go({ week: addDays(from, 7) })}
            >
              {t("workload.nextWeek")}
            </Button>
          </div>
        </div>
      }
    />
  );

  let body: ReactNode;
  if (grid.people.length === 0) {
    body = (
      <EmptyState
        icon="Gauge"
        sentence={t("workload.empty")}
        actionLabel={t("workload.toShifts")}
        onAction={() => router.push(`/${org}/crew/shifts` as Route)}
      />
    );
  } else if (view === "table") {
    body = (
      <DataTable
        caption={t("workload.tableLabel", { from: long(from), to: long(to) })}
        columns={[
          { key: "person", label: t("workload.columns.person") },
          { key: "day", label: t("workload.columns.day") },
          { key: "shifts", label: t("workload.columns.shifts"), type: "number" },
          { key: "tasks", label: t("workload.columns.tasks"), type: "number" },
          { key: "unestimated", label: t("workload.columns.unestimated"), type: "number" },
          { key: "total", label: t("workload.columns.total"), type: "number" },
          { key: "over", label: t("workload.columns.over") },
        ]}
        rows={workload.cells.map((c) => ({
          id: `${c.personId}:${c.day}`,
          person: name(c.personId),
          day: long(c.day),
          shifts: format.number(c.shiftMinutes / 60, { maximumFractionDigits: 2 }),
          tasks: format.number(c.taskHours, { maximumFractionDigits: 2 }),
          unestimated: c.unestimatedTasks,
          total: hours(c.totalHours),
          over: isOver(c.totalHours, workload.limit) ? over : "",
        }))}
        onRowActivate={(row) => go({ cell: String(row["id"]) })}
      />
    );
  } else {
    body = (
      <Heatmap
        label={t("workload.heatmapLabel", { from: long(from), to: long(to) })}
        rowHeader={t("workload.columns.person")}
        rows={grid.people.map((p) => ({ key: p.id, label: p.name ?? t("workload.unnamed") }))}
        columns={grid.days.map((d) => ({ key: d, label: short(d), fullLabel: long(d) }))}
        cells={Object.fromEntries(
          workload.cells.map((c) => [
            `${c.personId}:${c.day}`,
            {
              text: hours(c.totalHours),
              step: workloadStep(c.totalHours, workload.limit),
              ...(isOver(c.totalHours, workload.limit) ? { over } : {}),
            },
          ]),
        )}
        onCellActivate={(row, column) => go({ cell: `${row}:${column}` })}
      />
    );
  }

  const open = cell ? byKey.get(cell) : undefined;
  return (
    <TemplateCollection
      header={header}
      peek={
        open ? (
          <Drawer
            title={t("workload.cellTitle", { person: name(open.personId), day: long(open.day) })}
            open
            onOpenChange={(v) => (v ? undefined : go({ cell: null }))}
          >
            <PropertyList
              items={[
                { label: t("workload.columns.shifts"), value: hours(open.shiftMinutes / 60) },
                { label: t("workload.columns.tasks"), value: hours(open.taskHours) },
                { label: t("workload.columns.unestimated"), value: String(open.unestimatedTasks) },
                { label: t("workload.columns.total"), value: hours(open.totalHours) },
              ]}
            />
            {isOver(open.totalHours, workload.limit) ? (
              <p className="m-0 text-text-13 font-semibold">{over}</p>
            ) : null}
            <div className="flex flex-wrap gap-8">
              <Button
                icon="CalendarRange"
                onClick={() =>
                  router.push(
                    `/${org}/crew/shifts?view=resource-schedule&week=${open.day}` as Route,
                  )
                }
              >
                {t("workload.openShifts")}
              </Button>
              <Button
                icon="ListChecks"
                onClick={() => router.push(`/${org}/work/all-records?kind=Task` as Route)}
              >
                {t("workload.openTasks")}
              </Button>
            </div>
          </Drawer>
        ) : null
      }
    >
      <p className="m-0 text-text-13 text-text-secondary">
        {t("workload.help", { limit: workload.limit })}
      </p>
      {body}
    </TemplateCollection>
  );
}
