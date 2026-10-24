import {
  isCurrentEngagement,
  listMyApplications,
  listMyEngagements,
  listSharedRecords,
  readView,
} from "@xos/data/gateway";
import { getNode } from "@xos/ia";
import type { Metadata, Route } from "next";
import Link from "next/link";
import { getLocale } from "next-intl/server";
import { PageTitle, pickView, RegionError, ViewSwitcher } from "@/components/page/page";
import { CalendarDownload } from "@/components/page/up-next-actions";
import { DestinationTabs } from "@/components/page/work-tabs";
import { Calendar, EmptyStateLink, Icon } from "@/components/ui";
import { formatDate, formatScheduleTime } from "@/lib/format";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { getScheduleView, personToday } from "@/lib/time-zone";
import { enumLabelKey, getTranslate, type Translate } from "@/lib/shell/translate";
import { byDay, mergeUpcoming, type UpcomingItem } from "@/lib/upcoming";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("nav.gateway.work.upcoming") };
}

const ICONS: Record<UpcomingItem["kind"], string> = {
  shift: "CalendarClock",
  record: "CalendarDays",
  dock: "Truck",
  lodging: "BedDouble",
  interview: "MessagesSquare",
  start: "Flag",
};

function detailLabel(detail: string | null, t: Translate): string | null {
  if (!detail) return null;
  const [name, value] = detail.split(":");
  return name && value ? t(enumLabelKey(name, value)) : null;
}

/**
 * Work, Upcoming (Section 4.5.8): a list or calendar of every dated thing across orgs, with a
 * calendar file for any calendar app and a link to subscribe to the person's calendar feed
 * (Settings, Calendar Feeds). Each row opens its engagement in one tap.
 */
export default async function UpcomingPage({ searchParams }: PageProps<"/work/upcoming">) {
  const ctx = await requireNode("work.upcoming");
  const query = await searchParams;
  const views = getNode(sitemap, "work.upcoming").node.list?.views ?? ["list"];
  const view = pickView(query["view"], views, "list");
  const [t, locale, engagements] = await Promise.all([
    getTranslate(),
    getLocale(),
    listMyEngagements(ctx.db),
  ]);
  if (!engagements.ok) {
    return (
      <>
        <PageTitle title={t("nav.gateway.work.upcoming")} />
        <RegionError />
      </>
    );
  }
  const current = engagements.data.filter(isCurrentEngagement);
  const projectIds = [...new Set(current.map((e) => e.projectId))];
  const engagementIds = current.map((e) => e.id);
  const [shifts, records, docks, lodging, applications] = await Promise.all([
    readView(ctx.db, "shifts", { in: ["engagement_id", engagementIds] }),
    listSharedRecords(ctx.db, { projectIds }),
    readView(ctx.db, "dock_slots", { in: ["engagement_id", engagementIds] }),
    readView(ctx.db, "lodging", { in: ["project_id", projectIds] }),
    listMyApplications(ctx.db),
  ]);
  const failed = !shifts.ok || !records.ok || !docks.ok || !lodging.ok || !applications.ok;
  const now = new Date();
  // Upcoming spans engagements across orgs, so its calendar opens on the person's own today.
  const [today, schedule] = await Promise.all([personToday(ctx), getScheduleView(ctx)]);
  const items = mergeUpcoming({
    now,
    engagements: current,
    shifts: shifts.ok ? shifts.data : [],
    records: records.ok ? records.data : [],
    docks: docks.ok ? docks.data : [],
    lodging: lodging.ok ? lodging.data : [],
    interviews: applications.ok
      ? applications.data.flatMap((a) =>
          a.interviews.map((i) => ({
            id: i.id,
            title: a.opportunity?.title ?? "",
            orgName: a.opportunity?.orgName ?? null,
            at: i.scheduledAt,
          })),
        )
      : [],
  });
  const month =
    typeof query["month"] === "string" && /^\d{4}-\d{2}-01$/.test(query["month"])
      ? query["month"]
      : `${today.slice(0, 7)}-01`;
  const shiftMonth = (delta: number) => {
    const d = new Date(`${month}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + delta);
    return `${d.toISOString().slice(0, 7)}-01`;
  };

  return (
    <>
      <PageTitle
        title={t("nav.gateway.primary.work")}
        action={
          <>
            <ViewSwitcher views={views} current={view} path="/work/upcoming" query={query} />
            <Link
              href={"/settings/calendar-feeds" as Route}
              className="text-text-13 text-accent-text underline"
            >
              {t("gateway.settings.calendarFeeds.subscribe")}
            </Link>
            <CalendarDownload
              label={t("gateway.work.upcoming.download")}
              fileName="gateway-upcoming.ics"
              events={items.map((i) => ({
                uid: i.id,
                title: i.title,
                startsAt: i.at,
                endsAt: i.endsAt,
                location: i.projectName,
              }))}
            />
          </>
        }
      />
      <DestinationTabs ctx={ctx} destination="work" active="work.upcoming" t={t} />
      {failed ? <RegionError /> : null}
      {items.length === 0 && !failed ? (
        <EmptyStateLink
          icon="CalendarClock"
          sentence={t("gateway.work.upcoming.empty")}
          actionLabel={t("gateway.work.upcoming.emptyAction")}
          href="/explore"
        />
      ) : view === "calendar" ? (
        <div className="flex flex-col gap-12">
          <div className="flex items-center gap-8">
            <Link
              href={`/work/upcoming?view=calendar&month=${shiftMonth(-1)}` as Route}
              className="text-text-13 text-accent-text underline"
            >
              {t("gateway.work.upcoming.previousMonth")}
            </Link>
            <Link
              href={`/work/upcoming?view=calendar&month=${shiftMonth(1)}` as Route}
              className="text-text-13 text-accent-text underline"
            >
              {t("gateway.work.upcoming.nextMonth")}
            </Link>
          </div>
          <Calendar
            month={month}
            today={today}
            events={items.map((i) => ({
              date: i.at.slice(0, 10),
              label: i.title,
              state: "scheduled" as const,
            }))}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-16">
          {byDay(items).map(([day, dayItems]) => (
            <section key={day} aria-labelledby={`day-${day}`} className="flex flex-col gap-8">
              <h2 id={`day-${day}`} className="m-0 text-text-13 font-semibold text-text-secondary">
                {formatDate(locale, day)}
              </h2>
              <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle bg-bg-raised p-0">
                {dayItems.map((item) => {
                  const detail = detailLabel(item.detail, t);
                  const body = (
                    <>
                      <span className="text-text-secondary">
                        <Icon name={ICONS[item.kind]} size={18} />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-2">
                        <span className="font-medium">
                          {item.title || t(`gateway.work.upcoming.kinds.${item.kind}`)}
                        </span>
                        <span className="text-text-13 text-text-secondary">
                          {[
                            item.at.length > 10
                              ? formatScheduleTime(locale, item.at, item.timeZone, schedule)
                              : t(`gateway.work.upcoming.kinds.${item.kind}`),
                            item.orgName,
                            item.projectName,
                            detail,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                    </>
                  );
                  return (
                    <li key={item.id}>
                      {item.engagementKey ? (
                        <Link
                          href={`/work/engagements/${item.engagementKey}/overview` as Route}
                          className="flex min-h-touch-min items-center gap-12 px-16 py-12 text-text-primary no-underline hover:bg-bg-hover"
                        >
                          {body}
                        </Link>
                      ) : (
                        <div className="flex min-h-touch-min items-center gap-12 px-16 py-12">
                          {body}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
