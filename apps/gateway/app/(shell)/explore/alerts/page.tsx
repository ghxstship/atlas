import { listMySavedSearches } from "@xos/data/gateway";
import type { Metadata, Route } from "next";
import Link from "next/link";
import { getLocale } from "next-intl/server";
import { ActionButton } from "@/components/actions/action-button";
import { childTabLinks, PageTitle, RegionError, SectionTabs } from "@/components/page/page";
import { EmptyStateLink, Tag } from "@/components/ui";
import { removeSavedSearchAction, setAlertsAction } from "@/lib/actions/marketplace";
import { formatDateRange } from "@/lib/format";
import { childTabs } from "@/lib/shell/nav-model";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { enumLabelKey, getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("gateway.explore.alerts.title") };
}

/** Explore Alerts (Section 4.4.3): saved searches, each alerting by email and push when on. */
export default async function AlertsPage() {
  const ctx = await requireNode("explore.alerts");
  const [t, locale, searches] = await Promise.all([
    getTranslate(),
    getLocale(),
    listMySavedSearches(ctx.db),
  ]);
  const tabs = [
    { id: "explore", label: t("nav.gateway.primary.explore"), href: "/explore" },
    ...childTabLinks(childTabs(sitemap, "explore", ctx.nav), t),
  ];
  return (
    <>
      <PageTitle
        title={t("gateway.explore.alerts.title")}
        lead={t("gateway.explore.alerts.lead")}
      />
      <SectionTabs label={t("gateway.shell.pageTabs")} tabs={tabs} active="explore.alerts" />
      {!searches.ok ? (
        <RegionError />
      ) : searches.data.length === 0 ? (
        <EmptyStateLink
          icon="BellPlus"
          sentence={t("gateway.explore.alerts.empty")}
          actionLabel={t("gateway.explore.alerts.emptyAction")}
          href="/explore"
        />
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle bg-bg-raised p-0">
          {searches.data.map((s) => {
            const params = new URLSearchParams();
            if (s.roleType) params.set("role", s.roleType);
            if (s.startsAfter) params.set("from", s.startsAfter);
            if (s.endsBefore) params.set("to", s.endsBefore);
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-12 px-16 py-12">
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Link
                    href={`/explore?${params.toString()}` as Route}
                    className="font-medium text-text-primary"
                  >
                    {s.name}
                  </Link>
                  <span className="text-text-13 text-text-secondary">
                    {s.roleType
                      ? t(enumLabelKey("externalRoleType", s.roleType))
                      : t("gateway.explore.alerts.any")}
                    {s.startsAfter || s.endsBefore
                      ? ` · ${formatDateRange(locale, s.startsAfter, s.endsBefore)}`
                      : ""}
                  </span>
                </div>
                <Tag tone={s.alertsEnabled ? "success" : "neutral"}>
                  {s.alertsEnabled
                    ? t("gateway.explore.alerts.on")
                    : t("gateway.explore.alerts.off")}
                </Tag>
                <ActionButton
                  action={setAlertsAction.bind(null, s.id, !s.alertsEnabled)}
                  label={
                    s.alertsEnabled
                      ? t("gateway.explore.alerts.turnOff")
                      : t("gateway.explore.alerts.turnOn")
                  }
                />
                <ActionButton
                  action={removeSavedSearchAction.bind(null, s.id)}
                  label={t("gateway.explore.alerts.remove")}
                  variant="ghost"
                />
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
