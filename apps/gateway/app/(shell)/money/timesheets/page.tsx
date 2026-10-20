import { hoursFromMinutes, listMyEngagements, readView } from "@xos/data/gateway";
import { getNode } from "@xos/ia";
import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import { ActionButton } from "@/components/actions/action-button";
import { LinkTable } from "@/components/page/collections";
import { RowList } from "@/components/engagement/rows";
import { PageTitle, pickView, RegionError, ViewSwitcher } from "@/components/page/page";
import { DestinationTabs } from "@/components/page/work-tabs";
import { EmptyStateLink } from "@/components/ui";
import { submitTimesheetAction } from "@/lib/actions/operations";
import { formatDate, formatDateRange } from "@/lib/format";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { enumLabelKey, getTranslate } from "@/lib/shell/translate";
import { toneFor } from "@/lib/states";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("nav.gateway.money.timesheets") };
}

/** Money, Timesheets (Section 4.4.5): the person's own timesheets across engagements. */
export default async function TimesheetsPage({ searchParams }: PageProps<"/money/timesheets">) {
  const ctx = await requireNode("money.timesheets");
  const query = await searchParams;
  const views = getNode(sitemap, "money.timesheets").node.list?.views ?? ["table"];
  const view = pickView(query["view"], views, "table");
  const [t, locale, sheets, engagements] = await Promise.all([
    getTranslate(),
    getLocale(),
    readView(ctx.db, "timesheets", { order: ["period_start", "desc"] }),
    listMyEngagements(ctx.db),
  ]);
  const byId = new Map((engagements.ok ? engagements.data : []).map((e) => [e.id, e]));
  const rows = sheets.ok ? sheets.data : [];
  return (
    <>
      <PageTitle
        title={t("nav.gateway.primary.money")}
        action={
          <ViewSwitcher views={views} current={view} path="/money/timesheets" query={query} />
        }
      />
      <DestinationTabs ctx={ctx} destination="money" active="money.timesheets" t={t} />
      {!sheets.ok || !engagements.ok ? (
        <RegionError />
      ) : rows.length === 0 ? (
        <EmptyStateLink
          icon="Clock"
          sentence={t("gateway.money.timesheets.empty")}
          actionLabel={t("gateway.money.timesheets.emptyAction")}
          href="/work/upcoming"
        />
      ) : view === "list" ? (
        <RowList
          label={t("nav.gateway.money.timesheets")}
          items={rows.map((s) => {
            const e = s.engagement_id ? byId.get(s.engagement_id) : undefined;
            return {
              id: s.id ?? "",
              title: formatDateRange(locale, s.period_start, s.period_end),
              meta: [
                e?.orgName,
                s.project_name,
                t("gateway.engagement.timesheets.hours", {
                  n: hoursFromMinutes(s.worked_minutes) ?? 0,
                }),
              ],
              ...(s.timesheet_state
                ? {
                    tag: {
                      label: t(enumLabelKey("timesheetState", s.timesheet_state)),
                      tone: toneFor(s.timesheet_state),
                    },
                  }
                : {}),
              ...(e ? { href: `/work/engagements/${e.key}/timesheets` } : {}),
              ...((s.timesheet_state === "Proposed" || s.timesheet_state === "Rejected") && s.id
                ? {
                    action: (
                      <ActionButton
                        action={submitTimesheetAction.bind(null, s.id)}
                        label={t("gateway.engagement.timesheets.submit")}
                        variant="secondary"
                      />
                    ),
                  }
                : {}),
            };
          })}
        />
      ) : (
        <LinkTable
          caption={t("nav.gateway.money.timesheets")}
          columns={[
            { key: "period", label: t("gateway.money.timesheets.period") },
            { key: "org", label: t("gateway.work.engagements.org") },
            { key: "project", label: t("gateway.work.engagements.project") },
            { key: "hours", label: t("gateway.money.timesheets.hours"), type: "number" },
            { key: "submitted", label: t("gateway.work.applications.submitted") },
            { key: "state", label: t("gateway.work.engagements.state") },
          ]}
          rows={rows.map((s) => {
            const e = s.engagement_id ? byId.get(s.engagement_id) : undefined;
            return {
              ...(e ? { href: `/work/engagements/${e.key}/timesheets` } : {}),
              period: formatDateRange(locale, s.period_start, s.period_end),
              org: e?.orgName ?? "",
              project: s.project_name ?? "",
              hours: hoursFromMinutes(s.worked_minutes),
              submitted: s.submitted_at ? formatDate(locale, s.submitted_at) : "",
              state: s.timesheet_state ? t(enumLabelKey("timesheetState", s.timesheet_state)) : "",
            };
          })}
        />
      )}
    </>
  );
}
