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
  // Sections A86 filled (RRR-131): their old empty-state sentences no longer describe them.
  "settings.api-keys-and-service-accounts": "settings.descriptions.apiKeysAndServiceAccounts",
  "settings.webhooks": "settings.descriptions.webhooks",
  "settings.spend-authority": "settings.descriptions.spendAuthority",
  "settings.separation-of-duties": "settings.descriptions.separationOfDuties",
  "settings.custom-fields": "settings.descriptions.customFields",
  "settings.canon-extensions": "settings.descriptions.canonExtensions",
  "settings.data-and-privacy": "settings.descriptions.dataAndPrivacy",
  "settings.audit-log": "settings.descriptions.auditLog",
  "settings.automations": "settings.descriptions.automations",
  "settings.workspaces.workspace": "settings.descriptions.workspace",
  "settings.teams.team": "settings.descriptions.team",
  "me.connected-apps": "settings.descriptions.connectedApps",
  "me.developer": "settings.descriptions.developer",
  "me.payout-and-tax": "settings.descriptions.payoutAndTax",
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
