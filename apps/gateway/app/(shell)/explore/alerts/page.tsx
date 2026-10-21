import { listMyAlerts, listMySavedSearches, listOpportunitiesById } from "@xos/data/gateway";
import type { Metadata, Route } from "next";
import Link from "next/link";
import { getLocale } from "next-intl/server";
import { SwipeActions } from "@/components/explore/swipe-actions";
import {
  childTabLinks,
  PageTitle,
  RegionError,
  Section,
  SectionTabs,
} from "@/components/page/page";
import { EmptyStateLink, Tag } from "@/components/ui";
import {
  removeSavedSearchAction,
  restoreSavedSearchAction,
  setAlertsAction,
} from "@/lib/actions/marketplace";
import { formatDateRange, formatDateTime } from "@/lib/format";
import { childTabs } from "@/lib/shell/nav-model";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { enumLabelKey, getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("gateway.explore.alerts.title") };
}

/**
 * Explore Alerts (Section 4.4.3): the listings the person's saved searches matched, newest first (the
 * matcher of migration 1462 writes them, and each sends an email and a push), then the saved searches
 * themselves. A search row swipes right to turn its alerts on or off and left to remove it, with
 * buttons and keys for both (Section 11.10 habit 6).
 */
export default async function AlertsPage() {
  const ctx = await requireNode("explore.alerts");
  const [t, locale, searches, alerts] = await Promise.all([
    getTranslate(),
    getLocale(),
    listMySavedSearches(ctx.db),
    listMyAlerts(ctx.db, 30),
  ]);
  const openIds = alerts.ok ? alerts.data.filter((a) => a.open).map((a) => a.opportunityId) : [];
  const opportunities = await listOpportunitiesById(ctx.db, [...new Set(openIds)]);
  const byId = new Map((opportunities.ok ? opportunities.data : []).map((o) => [o.id, o]));
  const searchName = new Map((searches.ok ? searches.data : []).map((s) => [s.id, s.name]));
  const matches = (alerts.ok ? alerts.data : []).flatMap((a) => {
    const o = byId.get(a.opportunityId);
    return a.open && o ? [{ alert: a, o }] : [];
  });
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

      <Section title={t("gateway.explore.alerts.matches")}>
        {!alerts.ok || !opportunities.ok ? (
          <RegionError />
        ) : matches.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("gateway.explore.alerts.noMatches")}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle bg-bg-raised p-0">
            {matches.map(({ alert, o }) => (
              <li
                key={alert.id}
                className="flex flex-wrap items-center gap-x-12 gap-y-2 px-16 py-12"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Link
                    href={`/explore/${o.key}` as Route}
                    className="font-medium text-text-primary"
                  >
                    {o.title}
                  </Link>
                  <span className="text-text-13 text-text-secondary">
                    {o.orgName}
                    {o.startsOn ? ` · ${formatDateRange(locale, o.startsOn, o.endsOn)}` : ""}
                  </span>
                </div>
                <span className="text-text-12 text-text-secondary">
                  {t("gateway.explore.alerts.matchedBy", {
                    name: searchName.get(alert.savedSearchId) ?? "",
                    date: formatDateTime(locale, alert.matchedAt),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("gateway.explore.alerts.searches")}>
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
          <ul className="m-0 flex list-none flex-col gap-8 p-0">
            {searches.data.map((s) => {
              const params = new URLSearchParams();
              if (s.query) params.set("q", s.query);
              if (s.roleType) params.set("role", s.roleType);
              if (s.startsAfter) params.set("from", s.startsAfter);
              if (s.endsBefore) params.set("to", s.endsBefore);
              if (s.discCode) params.set("disc", s.discCode);
              if (s.catUrid) params.set("cat", s.catUrid);
              if (s.certificationName) params.set("cert", s.certificationName);
              if (s.near) {
                params.set("near", s.near.label);
                params.set("radius", String(s.near.radiusKm));
              }
              const details = [
                s.roleType
                  ? t(enumLabelKey("externalRoleType", s.roleType))
                  : t("gateway.explore.alerts.any"),
                s.startsAfter || s.endsBefore
                  ? formatDateRange(locale, s.startsAfter, s.endsBefore)
                  : null,
                s.discCode ?? null,
                s.certificationName ?? null,
                s.near
                  ? t("gateway.explore.alerts.within", { km: s.near.radiusKm, place: s.near.label })
                  : null,
              ].filter((d): d is string => Boolean(d));
              return (
                <li key={s.id}>
                  <SwipeActions
                    label={t("gateway.explore.swipe.actions", { title: s.name })}
                    failed={t("gateway.explore.swipe.failed")}
                    right={{
                      label: s.alertsEnabled
                        ? t("gateway.explore.alerts.turnOff")
                        : t("gateway.explore.alerts.turnOn"),
                      action: setAlertsAction.bind(null, s.id, !s.alertsEnabled),
                      icon: "Bell",
                      shortcut: "a",
                      done: s.alertsEnabled
                        ? t("gateway.explore.alerts.off")
                        : t("gateway.explore.alerts.on"),
                    }}
                    left={{
                      label: t("gateway.explore.alerts.remove"),
                      action: removeSavedSearchAction.bind(null, s.id),
                      icon: "Trash2",
                      shortcut: "r",
                      done: t("gateway.explore.swipe.removed", { title: s.name }),
                      hides: true,
                      undo: {
                        label: t("gateway.explore.swipe.undo"),
                        action: restoreSavedSearchAction.bind(null, s.id),
                      },
                    }}
                  >
                    <div className="flex flex-wrap items-center gap-12 rounded-card border border-border-subtle bg-bg-raised px-16 py-12">
                      <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <Link
                          href={`/explore?${params.toString()}` as Route}
                          className="font-medium text-text-primary"
                        >
                          {s.name}
                        </Link>
                        <span className="text-text-13 text-text-secondary">
                          {details.join(" · ")}
                        </span>
                      </div>
                      <Tag tone={s.alertsEnabled ? "success" : "neutral"}>
                        {s.alertsEnabled
                          ? t("gateway.explore.alerts.on")
                          : t("gateway.explore.alerts.off")}
                      </Tag>
                    </div>
                  </SwipeActions>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </>
  );
}
