import { listAllSavedViews, listTeams, myMembershipId } from "@xos/data/views";
import { getTranslations } from "next-intl/server";
import { EmptyPanel, ErrorPanel, RefusalPanel } from "@/components/platform/kit";
import { PageHeader, TemplateCollection } from "@/components/platform/client/page-header";
import { SavedViewsList, type SavedViewItem } from "@/components/saved-views/saved-views-list";
import { requireNode } from "@/components/shell/sitemap-page";
import { nodeHref, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { collectionLabelKey } from "@/lib/views/collections";
import { savedViewTarget } from "@/lib/views/target";

/**
 * Saved views (Section 11.15): every view the viewer can open in the org, theirs to rename, share
 * or delete and the ones shared with them, each linking to `/{org}/views/{viewId}`, which opens it
 * on its collection's page (A35). Row level security decides what is listed and what may change.
 */
export default async function Page({ params }: PageProps<"/[org]/views">) {
  const routeParams = await params;
  const ctx = await requireNode("saved-views", routeParams);
  const [t, label] = await Promise.all([getTranslations("savedViews"), getTranslate()]);
  const header = <PageHeader title={t("title")} />;
  const home = nodeHref("home", routeParams) ?? `/${ctx.org.slug}/home`;
  const person = ctx.viewer.person;
  const membership = person
    ? await myMembershipId(ctx.viewer.db, { orgId: ctx.org.id, personId: person.id })
    : null;
  if (!membership || (!membership.ok && membership.error.kind === "not-found")) {
    return (
      <TemplateCollection header={header}>
        <RefusalPanel reason={t("refusal")} actionLabel={t("refusalAction")} href={home} />
      </TemplateCollection>
    );
  }
  if (!membership.ok) {
    return (
      <TemplateCollection header={header}>
        <ErrorPanel sentence={t("loadError")} />
      </TemplateCollection>
    );
  }
  const [views, teams] = await Promise.all([
    listAllSavedViews(ctx.viewer.db, { orgId: ctx.org.id, membershipId: membership.data }),
    listTeams(ctx.viewer.db, ctx.org.id),
  ]);
  if (!views.ok || !teams.ok) {
    return (
      <TemplateCollection header={header}>
        <ErrorPanel sentence={t("loadError")} />
      </TemplateCollection>
    );
  }
  if (views.data.length === 0) {
    return (
      <TemplateCollection header={header}>
        <EmptyPanel
          icon="Bookmark"
          sentence={t("empty")}
          actionLabel={t("emptyAction")}
          href={nodeHref("projects", routeParams) ?? `/${ctx.org.slug}/projects`}
        />
      </TemplateCollection>
    );
  }
  const items: SavedViewItem[] = views.data.map((view) => {
    const key = collectionLabelKey(sitemap, view.collectionKey);
    const reachable = savedViewTarget(sitemap, view, ctx.org.slug, ctx.nav).kind !== "none";
    return {
      view,
      page: key && reachable ? t("page", { page: label(key) }) : t("pageUnknown"),
    };
  });
  return (
    <TemplateCollection header={<PageHeader title={t("title")} count={items.length} />}>
      <SavedViewsList
        org={ctx.org.slug}
        mine={items.filter((i) => i.view.mine)}
        shared={items.filter((i) => !i.view.mine)}
        teams={teams.data}
      />
    </TemplateCollection>
  );
}
