import { addCalendarDays, startOfDayIn, todayIn } from "@xos/data/calendar";
import { listTodayChanges, seenBaseline } from "@xos/data/change-tracking";
import { listMyRecordsBetween, nextDoors } from "@xos/data/home";
import { listInbox } from "@xos/data/inbox";
import { listProjects } from "@xos/data/projects";
import { resolveSettings } from "@xos/data/settings";
import type { DashboardTile } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { MarkSeenForm } from "@/components/change-tracking/mark-seen-form";
import { VisitMarker } from "@/components/change-tracking/visit-marker";
import { DashboardGrid } from "@/components/dashboard/dashboard-grid";
import { DoorsCountdown } from "@/components/home/doors-countdown";
import { TodayView } from "@/components/home/home-views";
import { DashboardTileFrame } from "@/components/home/today-tile";
import { PageHeader } from "@/components/ui";
import { formatMoney } from "@/components/work/format";
import { savedLayout } from "@/lib/dashboard/layout";
import { changeFieldKeys, waitingApprovals } from "@/lib/home/today";
import { pickView } from "@/lib/home/views";
import { must } from "@/lib/projects/loaders";
import { requireNode } from "@/lib/shell/require-node";
import { nodeHref } from "@/lib/shell/sitemap";
import { getOrgTimeZone } from "@/lib/shell/time-zone";

/** How many waiting approvals the tile lists; the count covers them all. */
const APPROVAL_ROWS = 5;

/**
 * Home > Today (Section 4.5.5, B6 G-249) on the Dashboard template (Section 11.6): the next doors
 * with a live countdown, the approvals waiting for the viewer, what others changed on their records
 * and shifts since their last visit (app.today_changes, from the audit ledger), and the day's work
 * itself. Tiles keep the spans the viewer saved in me.dashboard_layout.today. The visit is recorded
 * after the page is on screen (VisitMarker), so a prefetch never moves the baseline.
 */
export default async function Page({ params, searchParams }: PageProps<"/[org]/home/today">) {
  const routeParams = await params;
  const ctx = await requireNode("home.today", routeParams);
  const t = await getTranslations("home.today");
  const raw = await getTranslations();
  const format = await getFormatter();
  const db = ctx.viewer.db;
  // Today on the org's calendar, from its local midnight to the next (A71). Before, the window began at
  // the server's midnight and the date was UTC's, so the evening in New York showed tomorrow.
  const zone = await getOrgTimeZone(ctx);
  const today = todayIn(zone);
  const start = new Date(startOfDayIn(today, zone));
  const end = new Date(startOfDayIn(addCalendarDays(today, 1), zone));
  const personId = ctx.viewer.person?.id;
  const [records, projects, doors, inbox, baseline, changes, settings] = await Promise.all([
    personId
      ? listMyRecordsBetween(db, { orgId: ctx.org.id, personId, from: start, to: end })
      : Promise.resolve({ ok: true as const, data: [] }),
    listProjects(db, ctx.org.id),
    nextDoors(db, { orgId: ctx.org.id }),
    listInbox(db, ctx.org.id),
    seenBaseline(db, "Today", ctx.org.id),
    listTodayChanges(db, ctx.org.id),
    resolveSettings(db, { orgId: ctx.org.id }),
  ]);
  const edges = must(projects, "projects").flatMap((p) => [
    ...(p.startsOn === today ? [{ key: p.key, name: p.name, edge: "starts" as const }] : []),
    ...(p.endsOn === today ? [{ key: p.key, name: p.name, edge: "ends" as const }] : []),
  ]);
  const { views, view } = pickView("home.today", await searchParams);
  // A layout that cannot be read leaves every tile at its default span.
  const saved = savedLayout("today", (key) => (settings.ok ? settings.data.get(key)?.value : null));
  const inboxHref = nodeHref("inbox", routeParams) ?? null;
  const path = nodeHref("home.today", routeParams) ?? `/${ctx.org.slug}/home/today`;

  const next = must(doors, "next doors");
  const approvals = waitingApprovals(must(inbox, "inbox"));
  const since = must(baseline, "today baseline");
  const changed = must(changes, "today changes");
  const has = (key: string) => raw.has(key as never);
  const locale = await getLocale();
  // An amount in its currency's minor unit (ISO 4217): Intl knows each currency's digits.
  const money = (minor: number, currency: string) =>
    formatMoney(
      minor,
      currency,
      locale,
      new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2,
    );
  const label = (key: string) => (raw as unknown as (k: string) => string)(key);

  const tiles: DashboardTile[] = [
    {
      id: "doors",
      label: t("tiles.doors.title"),
      span: 4,
      minSpan: 3,
      content: (
        <DashboardTileFrame id="today-doors" title={t("tiles.doors.title")}>
          {next ? (
            <DoorsCountdown
              doorsAt={next.doorsAt}
              event={next.title}
              project={next.projectName}
              venue={next.venueName}
              timeZone={next.projectTimeZone}
              href={next.key ? `/${ctx.org.slug}/r/${next.key}` : null}
            />
          ) : (
            <p className="m-0 text-text-13 text-text-secondary">{t("tiles.doors.none")}</p>
          )}
        </DashboardTileFrame>
      ),
    },
    {
      id: "approvals",
      label: t("tiles.approvals.title"),
      span: 4,
      minSpan: 3,
      content: (
        <DashboardTileFrame
          id="today-approvals"
          title={t("tiles.approvals.title")}
          link={inboxHref ? { href: inboxHref, label: t("tiles.approvals.open") } : null}
        >
          {approvals.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("tiles.approvals.empty")}</p>
          ) : (
            <>
              <p className="m-0 text-text-13 font-medium" data-testid="today-approvals-count">
                {t("tiles.approvals.count", { count: approvals.length })}
              </p>
              <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
                {approvals.slice(0, APPROVAL_ROWS).map((a) => (
                  <li key={a.id} className="flex flex-wrap justify-between gap-8 py-6 text-text-13">
                    <span>
                      {a.approval?.documentType ?? a.kind}
                      {a.approval?.reference ? ` · ${a.approval.reference}` : ""}
                    </span>
                    {a.approval?.amountMinor !== null &&
                    a.approval?.amountMinor !== undefined &&
                    a.approval.currency ? (
                      <span className="tabular-nums text-text-secondary">
                        {money(a.approval.amountMinor, a.approval.currency)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )}
        </DashboardTileFrame>
      ),
    },
    {
      id: "changes",
      label: t("tiles.changes.title"),
      span: 4,
      minSpan: 3,
      content: (
        <DashboardTileFrame
          id="today-changes"
          title={t("tiles.changes.title")}
          actions={
            <MarkSeenForm
              surface="Today"
              scopeId={ctx.org.id}
              path={path}
              label={t("tiles.changes.markAllSeen")}
            />
          }
        >
          {since === null ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("tiles.changes.firstVisit")}</p>
          ) : (
            <>
              <p className="m-0 text-text-12 text-text-secondary">
                {t("tiles.changes.since", {
                  date: format.dateTime(new Date(since), {
                    timeZone: zone,
                    dateStyle: "medium",
                    timeStyle: "short",
                  }),
                })}
              </p>
              {changed.length === 0 ? (
                <p className="m-0 text-text-13 text-text-secondary">{t("tiles.changes.empty")}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
                  {changed.flatMap((c) => {
                    const keys = changeFieldKeys(c, has);
                    if (c.kind === "changed" && keys.length === 0) return [];
                    const name = c.actorName ?? t("tiles.changes.someone");
                    const href =
                      c.table === "app.records" && c.key
                        ? `/${ctx.org.slug}/r/${c.key}`
                        : `/${ctx.org.slug}/crew/shifts?peek=${c.subjectId}`;
                    return [
                      <li key={`${c.table}-${c.subjectId}`} className="flex flex-col gap-2 py-6">
                        <Link
                          href={href as Route}
                          className="text-text-13 font-medium text-text-primary"
                        >
                          {c.key ? `${c.key} · ${c.title ?? ""}` : (c.title ?? "")}
                        </Link>
                        <span className="text-text-12 text-text-secondary">
                          {c.kind === "changed"
                            ? t("tiles.changes.row", {
                                name,
                                fields: format.list(keys.map(label), { type: "conjunction" }),
                              })
                            : t(
                                c.kind === "added"
                                  ? "tiles.changes.added"
                                  : "tiles.changes.removed",
                                {
                                  name,
                                },
                              )}
                          {" · "}
                          {format.dateTime(new Date(c.changedAt), {
                            timeZone: zone,
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </span>
                      </li>,
                    ];
                  })}
                </ul>
              )}
            </>
          )}
        </DashboardTileFrame>
      ),
    },
    {
      id: "today",
      label: t("tiles.today.title"),
      span: 12,
      minSpan: 6,
      content: (
        <TodayView
          org={ctx.org.slug}
          records={must(records, "today's records")}
          projects={edges}
          views={views}
          view={view}
          projectsHref={nodeHref("projects", routeParams) ?? ""}
        />
      ),
    },
  ];

  return (
    <>
      <VisitMarker surface="Today" scopeId={ctx.org.id} />
      <DashboardGrid
        dashboard="today"
        header={<PageHeader title={t("title")} />}
        tiles={tiles}
        saved={saved}
        label={t("layoutLabel")}
      />
    </>
  );
}
