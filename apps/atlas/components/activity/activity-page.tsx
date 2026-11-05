import { labelActivity, listActivity, restorableEntries } from "@xos/data/activity";
import { getNode } from "@xos/ia";
import { getTranslations } from "next-intl/server";
import { LoadError } from "@/components/projects/load-error";
import { PageHeader, TemplateCollection } from "@/components/projects/ui";
import type { OrgContext } from "@/lib/shell/context";
import { nodeHref, sitemap } from "@/lib/shell/sitemap";
import { ActivityFeed, type ActivityView } from "./activity-feed";

type Search = Readonly<Record<string, string | string[] | undefined>>;

const ACTIVITY_VIEWS: readonly ActivityView[] = ["feed", "list", "table"];

function one(search: Search, name: string): string | undefined {
  const v = search[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * An activity feed page (Section 4.5.5 Activity > Org activity feed, Section 4.5.4 project
 * Activity): newest first through app.activity_feed, in the views the sitemap allows, paged by
 * time with `before`. Entries for rows still in Trash offer Restore (Section 11.7).
 */
export async function ActivityPage({
  ctx,
  node,
  params,
  searchParams,
  project,
}: {
  ctx: OrgContext;
  node: string;
  params: Readonly<Record<string, string>>;
  searchParams: Search;
  project?: { readonly id: string; readonly key: string };
}) {
  const t = await getTranslations("activity.feed");
  const list = getNode(sitemap, node).node.list;
  const views = (list?.views ?? ["feed"]).filter((v): v is ActivityView =>
    (ACTIVITY_VIEWS as readonly string[]).includes(v),
  );
  const requested = one(searchParams, "view");
  const view = views.find((v) => v === requested) ?? (list?.default as ActivityView) ?? "feed";
  const beforeParam = one(searchParams, "before");
  const before = beforeParam && !Number.isNaN(Date.parse(beforeParam)) ? beforeParam : null;
  const page = await listActivity(ctx.viewer.db, {
    orgId: ctx.org.id,
    projectId: project?.id ?? null,
    before,
    limit: 50,
  });
  if (!page.ok) return <LoadError title={t("title")} />;
  const [entries, restorable] = await Promise.all([
    labelActivity(ctx.viewer.db, page.data.entries),
    restorableEntries(ctx.viewer.db, page.data.entries),
  ]);
  const emptyHref = project
    ? (nodeHref("project.overview", params) ?? "")
    : (nodeHref("projects", params) ?? "");
  return (
    <TemplateCollection header={<PageHeader title={t("title")} />}>
      <ActivityFeed
        label={project ? t("projectLabel", { key: project.key }) : t("label")}
        entries={entries}
        restorable={restorable}
        views={views}
        view={view}
        next={page.data.next}
        paged={before !== null}
        empty={
          project
            ? { sentence: t("projectEmpty"), action: t("projectEmptyAction"), href: emptyHref }
            : { sentence: t("empty"), action: t("emptyAction"), href: emptyHref }
        }
      />
    </TemplateCollection>
  );
}
