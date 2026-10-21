import { getNode } from "@xos/ia";
import { PageHeader } from "@/components/ui";
import { pageCopyKey, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Pages whose catalog empty-state sentence says the page is empty ("No teams yet") get a
 * description of their own once they show content.
 */
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  "settings.teams": "settings.descriptions.teams",
  "settings.workspaces": "settings.descriptions.workspaces",
  "settings.access-reviews": "settings.descriptions.accessReviews",
  "settings.partner": "settings.descriptions.partner",
  "settings.usage": "settings.descriptions.usage",
  "settings.templates": "settings.descriptions.templates",
  "me.calendar-feeds": "settings.descriptions.calendarFeeds",
};

/** A settings section's title from the sitemap and its one-sentence description from the catalog. */
export async function SectionHeader({ node }: { node: string }) {
  const t = await getTranslate();
  return (
    <>
      <PageHeader title={t(getNode(sitemap, node).node.label)} />
      <p className="m-0 text-text-13 text-text-secondary">
        {t(DESCRIPTIONS[node] ?? `${pageCopyKey(node)}.empty`)}
      </p>
    </>
  );
}
