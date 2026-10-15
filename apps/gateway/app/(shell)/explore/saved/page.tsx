import { listOpportunitiesById, listSavedOpportunities } from "@xos/data/gateway";
import { getNode } from "@xos/ia";
import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import { ActionButton } from "@/components/actions/action-button";
import { OpportunityLinkCard } from "@/components/page/opportunity-card";
import {
  childTabLinks,
  PageTitle,
  pickView,
  RegionError,
  SectionTabs,
  ViewSwitcher,
} from "@/components/page/page";
import { EmptyStateLink, Tag } from "@/components/ui";
import { unsaveOpportunityAction } from "@/lib/actions/marketplace";
import { childTabs } from "@/lib/shell/nav-model";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("gateway.explore.saved.title") };
}

/** Explore Saved (Section 4.5.8): opportunities the person saved, closed ones marked. */
export default async function SavedPage({ searchParams }: PageProps<"/explore/saved">) {
  const ctx = await requireNode("explore.saved");
  const query = await searchParams;
  const [t, locale, saved] = await Promise.all([
    getTranslate(),
    getLocale(),
    listSavedOpportunities(ctx.db),
  ]);
  const views = getNode(sitemap, "explore.saved").node.list?.views ?? ["gallery"];
  const view = pickView(query["view"], views, "gallery");
  const opportunities = saved.ok
    ? await listOpportunitiesById(
        ctx.db,
        saved.data.map((s) => s.opportunityId),
      )
    : null;
  const tabs = [
    { id: "explore", label: t("nav.gateway.primary.explore"), href: "/explore" },
    ...childTabLinks(childTabs(sitemap, "explore", ctx.nav), t),
  ];
  const byId = new Map((opportunities?.ok ? opportunities.data : []).map((o) => [o.id, o]));
  return (
    <>
      <PageTitle
        title={t("gateway.explore.saved.title")}
        lead={t("gateway.explore.saved.lead")}
        action={<ViewSwitcher views={views} current={view} path="/explore/saved" query={query} />}
      />
      <SectionTabs label={t("gateway.shell.pageTabs")} tabs={tabs} active="explore.saved" />
      {!saved.ok || (opportunities && !opportunities.ok) ? (
        <RegionError />
      ) : saved.data.length === 0 ? (
        <EmptyStateLink
          icon="Bookmark"
          sentence={t("gateway.explore.saved.empty")}
          actionLabel={t("gateway.explore.saved.emptyAction")}
          href="/explore"
        />
      ) : (
        <ul
          className={
            view === "list"
              ? "m-0 flex list-none flex-col gap-8 p-0"
              : "m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,var(--ui-gateway-aside)),1fr))] gap-12 p-0"
          }
        >
          {saved.data.map((s) => {
            const o = byId.get(s.opportunityId);
            return (
              <li key={s.id} className="flex flex-col gap-8">
                {o ? <OpportunityLinkCard opportunity={o} locale={locale} t={t} /> : null}
                <div className="flex items-center gap-8">
                  {!s.open ? <Tag tone="warning">{t("gateway.explore.saved.closed")}</Tag> : null}
                  <ActionButton
                    action={unsaveOpportunityAction.bind(null, s.id)}
                    label={t("gateway.explore.detail.unsave")}
                    variant="ghost"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
