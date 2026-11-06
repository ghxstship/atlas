import { addCalendarDays, todayIn } from "@xos/data/calendar";
import { listChangesSince, seenBaseline, type RowChange } from "@xos/data/change-tracking";
import { getOperationsAccess } from "@xos/data/logistics";
import { listRunsOfShow } from "@xos/data/show";
import { resolveSettings } from "@xos/data/settings";
import type { DashboardTile } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { MarkSeenForm } from "@/components/change-tracking/mark-seen-form";
import { VisitMarker } from "@/components/change-tracking/visit-marker";
import { DashboardGrid } from "@/components/dashboard/dashboard-grid";
import { DashboardTileFrame } from "@/components/home/today-tile";
import { LiveRefresh } from "@/components/live/live-refresh";
import { ButtonLink, PageHeader } from "@/components/ui";
import { requireModuleNode } from "@/components/work/load";
import { savedLayout } from "@/lib/dashboard/layout";
import { historyLabelKey } from "@/lib/history/fields";
import { must } from "@/lib/projects/loaders";
import { nodeHref } from "@/lib/shell/sitemap";
import {
  loadShowDay,
  pickShowDayProject,
  runProgress,
  setsByStage,
  showDayProjects,
} from "@/lib/show/show-day";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Show > Show day (Section 4.5.5, B6 G-179) on the Dashboard template (Section 11.6): one project's
 * show day at a glance. Sets by stage with what is called and up next, each running order's
 * progress, who arrives that day and who sleeps where that night, the last two for viewers with
 * hospitality.fulfillment.read. Rows changed since the viewer's last look carry a Changed tag that
 * names the fields (app.changes_since over the 'Show Day' baseline); cues, running orders, travel
 * and rooms refresh the page live. Tiles keep the spans saved in me.dashboard_layout.show_day.
 */
export default async function Page({ params, searchParams }: PageProps<"/[org]/show/show-day">) {
  const routeParams = await params;
  const ctx = await requireModuleNode("show.show-day", routeParams);
  const search = await searchParams;
  const t = await getTranslations("show.showDay");
  const raw = await getTranslations();
  const format = await getFormatter();
  const db = ctx.viewer.db;
  const base = nodeHref("show.show-day", routeParams) ?? `/${ctx.org.slug}/show/show-day`;
  const runsHref = nodeHref("show.run-of-show", routeParams) ?? `/${ctx.org.slug}/show/run-of-show`;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : null);

  // The projects the viewer reads running orders of (show.run_of_show.read decides through RLS).
  const [allRuns, settings] = await Promise.all([
    listRunsOfShow(db, { orgId: ctx.org.id }),
    resolveSettings(db, { orgId: ctx.org.id }),
  ]);
  const projects = showDayProjects(must(allRuns, "running orders"));
  const project = pickShowDayProject(projects, one(search["project"]));
  const saved = savedLayout("showDay", (key) =>
    settings.ok ? settings.data.get(key)?.value : null,
  );
  const header = <PageHeader title={t("title")} />;

  if (!project) {
    return (
      <DashboardGrid
        dashboard="showDay"
        header={header}
        saved={saved}
        label={t("layoutLabel")}
        tiles={[
          {
            id: "sets",
            label: t("tiles.sets.title"),
            span: 12,
            minSpan: 6,
            content: (
              <DashboardTileFrame id="show-day-empty" title={t("emptyTitle")}>
                <p className="m-0 text-text-13 text-text-secondary">{t("noProject")}</p>
                <div>
                  <ButtonLink href={runsHref} size="sm">
                    {t("openRunOfShow")}
                  </ButtonLink>
                </div>
              </DashboardTileFrame>
            ),
          },
        ]}
      />
    );
  }

  const zone = project.timeZone;
  const askedDay = one(search["day"]);
  const day = askedDay && DAY.test(askedDay) ? askedDay : todayIn(zone);
  const access = must(await getOperationsAccess(db, ctx.org.id), "operations access");
  const hospitality = access.can(project.id, "hospitality.fulfillment.read");
  const [data, baseline] = await Promise.all([
    loadShowDay(db, { orgId: ctx.org.id, project, day, hospitality }),
    seenBaseline(db, "Show Day", project.id),
  ]);
  const show = must(data, "show day");
  const since = must(baseline, "show day baseline");
  const arrivals = show.arrivals ?? [];
  const hotels = show.hotels ?? [];
  const [cueChanges, travelChanges, roomChanges] = await Promise.all([
    listChangesSince(
      db,
      "app.cues",
      show.cues.map((c) => c.id),
      since,
    ),
    listChangesSince(
      db,
      "app.travel_segments",
      arrivals.map((s) => s.id),
      since,
    ),
    listChangesSince(
      db,
      "app.accommodation_assignments",
      hotels.flatMap((h) => h.assignmentIds),
      since,
    ),
  ]);
  const cueChanged = must(cueChanges, "cue changes");
  const travelChanged = must(travelChanges, "travel changes");
  const roomChanged = must(roomChanges, "room changes");

  const label = (key: string) => (raw as unknown as (k: string) => string)(key);
  // A Changed tag names the fields from the shared column dictionary; a new row reads New.
  const changedTag = (change: RowChange | undefined) => {
    if (!change) return null;
    const text =
      change.kind === "added"
        ? t("new")
        : t("changed", {
            fields: format.list(
              change.fields.flatMap((f) => {
                const key = historyLabelKey(f);
                return key && raw.has(key as never) ? [label(key)] : [];
              }),
              { type: "conjunction" },
            ),
          });
    return (
      <span className="rounded-chip bg-bg-hover px-6 py-2 text-text-12 font-medium text-accent-text">
        {text}
      </span>
    );
  };
  const time = (iso: string | null, timeZone: string = zone) =>
    iso
      ? format.dateTime(new Date(iso), {
          timeZone,
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        })
      : t("noTime");
  const minutes = (seconds: number | null) =>
    seconds === null ? null : t("minutes", { minutes: Math.round(seconds / 60) });

  const stages = setsByStage(show.runs, show.cues, show.links, show.stageNames);
  const progress = runProgress(show.runs, show.cues, show.stageNames);
  const projectShowHref = `/${ctx.org.slug}/p/${project.key}/show`;
  const dayHref = (d: string) => `${base}?project=${encodeURIComponent(project.key)}&day=${d}`;

  const tiles: DashboardTile[] = [
    {
      id: "sets",
      label: t("tiles.sets.title"),
      span: 8,
      minSpan: 4,
      content: (
        <DashboardTileFrame id="show-day-sets" title={t("tiles.sets.title")}>
          {stages.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("tiles.sets.empty")}</p>
          ) : (
            stages.map((stage) => (
              <div key={stage.runOfShowId} className="flex flex-col gap-4">
                <h3 className="m-0 text-text-13 font-semibold">{stage.stage}</h3>
                <ul
                  aria-label={stage.stage}
                  className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
                >
                  {stage.sets.map((set) => (
                    <li
                      key={set.cueId}
                      className="flex flex-wrap items-center justify-between gap-8 py-6 text-text-13"
                    >
                      <span className="flex flex-col">
                        <span className="font-medium">{set.actName ?? set.label}</span>
                        <span className="text-text-12 text-text-secondary">
                          {[
                            time(set.plannedAt),
                            set.actName ? set.label : null,
                            minutes(set.durationSeconds),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <span className="flex flex-wrap items-center gap-6">
                        {changedTag(cueChanged.get(set.cueId))}
                        <span className="text-text-12 text-text-secondary">
                          {set.state === "called"
                            ? t("tiles.sets.called", { time: time(set.calledAt) })
                            : t(set.state === "next" ? "tiles.sets.next" : "tiles.sets.planned")}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </DashboardTileFrame>
      ),
    },
    {
      id: "run-of-show",
      label: t("tiles.runOfShow.title"),
      span: 4,
      minSpan: 3,
      content: (
        <DashboardTileFrame
          id="show-day-runs"
          title={t("tiles.runOfShow.title")}
          link={{ href: projectShowHref, label: t("tiles.runOfShow.open") }}
        >
          {progress.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("tiles.runOfShow.empty")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
              {progress.map((r) => (
                <li key={r.runOfShowId} className="flex flex-col gap-2 py-6 text-text-13">
                  <Link
                    href={`${projectShowHref}?peek=${r.runOfShowId}` as Route}
                    className="font-medium text-text-primary"
                  >
                    {r.stage === r.name ? r.name : `${r.stage} · ${r.name}`}
                  </Link>
                  <span className="text-text-12 text-text-secondary">
                    {t("tiles.runOfShow.progress", { called: r.called, total: r.total })}
                    {r.next
                      ? ` · ${t("tiles.runOfShow.nextCue", { cue: r.next.label, time: time(r.next.plannedAt) })}`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DashboardTileFrame>
      ),
    },
    ...(show.arrivals
      ? [
          {
            id: "arrivals",
            label: t("tiles.arrivals.title"),
            span: 6,
            minSpan: 4,
            content: (
              <DashboardTileFrame id="show-day-arrivals" title={t("tiles.arrivals.title")}>
                {arrivals.length === 0 ? (
                  <p className="m-0 text-text-13 text-text-secondary">
                    {t("tiles.arrivals.empty")}
                  </p>
                ) : (
                  <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
                    {arrivals.map((s) => (
                      <li
                        key={s.id}
                        className="flex flex-wrap items-center justify-between gap-8 py-6 text-text-13"
                      >
                        <span className="flex flex-col">
                          <span className="font-medium">{s.personName ?? t("unnamed")}</span>
                          <span className="text-text-12 text-text-secondary">
                            {[
                              t("tiles.arrivals.route", {
                                from: s.departsFrom,
                                to: s.arrivesAtPlace,
                              }),
                              [s.operatorName, s.serviceIdentifier].filter(Boolean).join(" "),
                              s.arrivesAt
                                ? t("tiles.arrivals.arrives", {
                                    time: time(s.arrivesAt, s.arrivesTimeZone),
                                  })
                                : t("tiles.arrivals.departs", {
                                    time: time(s.departsAt, s.departsTimeZone),
                                  }),
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </span>
                        <span className="flex flex-wrap items-center gap-6">
                          {changedTag(travelChanged.get(s.id))}
                          <span className="rounded-chip bg-bg-hover px-6 py-2 text-text-12">
                            {t(`tiles.arrivals.mode.${s.mode}`)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </DashboardTileFrame>
            ),
          },
          {
            id: "hotels",
            label: t("tiles.hotels.title"),
            span: 6,
            minSpan: 4,
            content: (
              <DashboardTileFrame id="show-day-hotels" title={t("tiles.hotels.title")}>
                {hotels.length === 0 ? (
                  <p className="m-0 text-text-13 text-text-secondary">{t("tiles.hotels.empty")}</p>
                ) : (
                  <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
                    {hotels.map((h) => {
                      const change = h.assignmentIds.map((id) => roomChanged.get(id)).find(Boolean);
                      return (
                        <li key={h.blockId} className="flex flex-col gap-2 py-6 text-text-13">
                          <span className="flex flex-wrap items-center justify-between gap-8">
                            <span className="font-medium">
                              {h.hotelName ? `${h.hotelName} · ${h.blockTitle}` : h.blockTitle}
                            </span>
                            {changedTag(change)}
                          </span>
                          <span className="text-text-12 text-text-secondary">
                            {t("tiles.hotels.guests", { count: h.guests.length })}
                          </span>
                          {h.checkIns.length > 0 ? (
                            <span className="text-text-12">
                              {t("tiles.hotels.checkIns", {
                                names: format.list(h.checkIns, { type: "conjunction" }),
                              })}
                            </span>
                          ) : null}
                          {h.checkOuts.length > 0 ? (
                            <span className="text-text-12">
                              {t("tiles.hotels.checkOuts", {
                                names: format.list(h.checkOuts, { type: "conjunction" }),
                              })}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </DashboardTileFrame>
            ),
          },
        ]
      : []),
  ];

  const controls = (
    <div className="flex flex-wrap items-end gap-8">
      <p className="m-0 basis-full text-text-13 text-text-secondary">
        {t("subtitle", {
          project: project.name,
          day: format.dateTime(new Date(`${day}T12:00:00Z`), {
            timeZone: "UTC",
            dateStyle: "full",
          }),
        })}
      </p>
      <form method="get" action={base} className="flex flex-wrap items-end gap-8">
        <label className="flex flex-col gap-2 text-text-12 text-text-secondary">
          {t("project")}
          <select
            name="project"
            defaultValue={project.key}
            className="h-control-md rounded-control border border-border-control bg-bg-surface px-8 text-text-13 text-text-primary"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.key}>
                {t("projectOption", { key: p.key, name: p.name })}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-2 text-text-12 text-text-secondary">
          {t("day")}
          <input
            type="date"
            name="day"
            defaultValue={day}
            className="h-control-md rounded-control border border-border-control bg-bg-surface px-8 text-text-13 text-text-primary"
          />
        </label>
        <button
          type="submit"
          className="h-control-md rounded-control border border-border-control px-12 text-text-13 hover:bg-bg-hover"
        >
          {t("go")}
        </button>
      </form>
      <nav aria-label={t("dayNav")} className="flex items-center gap-4">
        <Link
          href={dayHref(addCalendarDays(day, -1)) as Route}
          className="rounded-control px-8 py-4 text-text-12 text-text-secondary hover:bg-bg-hover"
        >
          {t("previousDay")}
        </Link>
        <Link
          href={dayHref(addCalendarDays(day, 1)) as Route}
          className="rounded-control px-8 py-4 text-text-12 text-text-secondary hover:bg-bg-hover"
        >
          {t("nextDay")}
        </Link>
      </nav>
      <MarkSeenForm surface="Show Day" scopeId={project.id} path={base} label={t("markAllSeen")} />
    </div>
  );

  return (
    <>
      <VisitMarker surface="Show Day" scopeId={project.id} />
      {/* Cues, running orders, travel and rooms refresh the page as they change (Section 11.7). */}
      <LiveRefresh
        topics={[
          { table: "cues", filter: `project_id=eq.${project.id}` },
          { table: "run_of_show", filter: `project_id=eq.${project.id}` },
          { table: "travel_segments", filter: `project_id=eq.${project.id}` },
          // Room assignments carry no project of their own, so they are watched by org.
          { table: "accommodation_assignments", filter: `org_id=eq.${ctx.org.id}` },
        ]}
      />
      <DashboardGrid
        dashboard="showDay"
        header={header}
        controls={controls}
        tiles={tiles}
        saved={saved}
        label={t("layoutLabel")}
      />
    </>
  );
}
