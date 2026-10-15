import type { Metadata } from "next";
import { childTabLinks, PageTitle, SectionTabs } from "@/components/page/page";
import { RefusalLink } from "@/components/ui";
import { childTabs } from "@/lib/shell/nav-model";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("gateway.explore.saved.title") };
}

/**
 * Explore Saved (Section 4.5.8). Saving one opportunity needs a person-owned saved-opportunity
 * table and its api_external view, which A28b is adding (requested by A27). Until then the page
 * says so and points to saved searches, which do work, rather than offering a save that cannot
 * be kept.
 */
export default async function SavedPage() {
  const ctx = await requireNode("explore.saved");
  const t = await getTranslate();
  const tabs = [
    { id: "explore", label: t("nav.gateway.primary.explore"), href: "/explore" },
    ...childTabLinks(childTabs(sitemap, "explore", ctx.nav), t),
  ];
  return (
    <>
      <PageTitle title={t("gateway.explore.saved.title")} lead={t("gateway.explore.saved.lead")} />
      <SectionTabs label={t("gateway.shell.pageTabs")} tabs={tabs} active="explore.saved" />
      <RefusalLink
        title={t("gateway.explore.saved.title")}
        reason={t("gateway.explore.saved.unavailable")}
        actionLabel={t("gateway.explore.saved.action")}
        href="/explore/alerts"
      />
    </>
  );
}
