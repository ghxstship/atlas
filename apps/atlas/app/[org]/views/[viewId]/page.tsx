import { isNodeVisible } from "@xos/ia";
import { getSavedView, myMembershipId } from "@xos/data/views";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { EmptyStateLink, PageHeader } from "@/components/ui";
import { getOrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";
import { savedViewTarget } from "@/lib/views/target";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A saved view by link (Section 11.15). It opens the page its collection belongs to with the view's
 * query, the same screen the view menu opens. A view the person cannot read (another person's
 * private view, a team they are not in) answers 404 without saying it exists (ADR 0006). A project
 * tab view needs a project, so the page names that next step.
 */
export default async function SavedViewPage({ params }: PageProps<"/[org]/views/[viewId]">) {
  const { org, viewId } = await params;
  const ctx = await getOrgContext(org);
  if (!ctx?.viewer.person || !isNodeVisible(sitemap, "saved-view", ctx.nav)) notFound();
  if (!UUID.test(viewId)) notFound();
  const membership = await myMembershipId(ctx.viewer.db, {
    orgId: ctx.org.id,
    personId: ctx.viewer.person.id,
  });
  if (!membership.ok) notFound();
  const view = await getSavedView(ctx.viewer.db, {
    orgId: ctx.org.id,
    membershipId: membership.data,
    viewId,
  });
  if (!view.ok) {
    if (view.error.kind === "not-found") notFound();
    throw new Error(`Cannot read the saved view: ${JSON.stringify(view.error)}`);
  }
  const target = savedViewTarget(sitemap, view.data, ctx.org.slug, ctx.nav);
  if (target.kind === "none") notFound();
  if (target.kind === "page") redirect(target.href);
  const t = await getTranslations("views.open");
  return (
    <>
      <PageHeader title={view.data.name} />
      <EmptyStateLink
        icon="FolderKanban"
        sentence={t("projectSentence")}
        actionLabel={t("projectAction")}
        href={`/${ctx.org.slug}/projects`}
      />
    </>
  );
}
