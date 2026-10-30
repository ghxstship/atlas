import { listOpportunitiesById, listSavedOpportunities } from "@xos/data/gateway";
import { getNode } from "@xos/ia";
import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import { SwipeActions } from "@/components/explore/swipe-actions";
import { LiveRefresh } from "@/components/live/live-refresh";
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
import { saveOpportunityAction, unsaveListingAction } from "@/lib/actions/marketplace";
import { personTopic } from "@/lib/live/topics";
import { childTabs } from "@/lib/shell/nav-model";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("gateway.explore.saved.title") };
}

/**
 * Explore Saved (Section 4.5.8): opportunities the person saved, closed ones marked. Removing one
 * goes on the undo stack (Cmd or Ctrl+Z saves it again), and the list updates live when the person
 * saves or removes a listing on another device.
 */
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
      <LiveRefresh topics={[personTopic("saved_opportunities", "person_id", ctx.personId)]} />
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
            const title = o?.title ?? t("gateway.explore.saved.closed");
            return (
              <li key={s.id}>
                {/* Swipe left to remove on a phone; the Remove button and the R key do the same. */}
                <SwipeActions
                  label={t("gateway.explore.swipe.actions", { title })}
                  failed={t("gateway.explore.swipe.failed")}
                  left={{
                    label: t("gateway.explore.detail.unsave"),
                    // By the listing, so redo after an undo removes the saved row the undo made.
                    action: unsaveListingAction.bind(null, s.opportunityId),
                    icon: "Trash2",
                    shortcut: "r",
                    done: t("gateway.explore.swipe.removed", { title }),
                    hides: true,
                    undo: {
                      label: t("gateway.explore.swipe.undo"),
                      action: saveOpportunityAction.bind(null, s.opportunityId),
                    },
                  }}
                >
                  <div className="flex flex-col gap-8">
                    {o ? (
                      <OpportunityLinkCard opportunity={o} locale={locale} t={t} headingLevel={2} />
                    ) : null}
                    {!s.open ? (
                      <div>
                        <Tag tone="warning">{t("gateway.explore.saved.closed")}</Tag>
                      </div>
                    ) : null}
                  </div>
                </SwipeActions>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
