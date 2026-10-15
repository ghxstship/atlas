import { EmptyStateLink } from "@/components/ui";
import { requireNode } from "@/components/shell/sitemap-page";
import { pageSettings } from "@/lib/settings/registry";
import { emptyStateHref, pageCopyKey } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { CONTRIBUTIONS } from "./contributions/index.generated";
import { RegistrySection } from "./registry-section";
import { SectionHeader } from "./section-header";

type Params = Readonly<Record<string, string>>;

/**
 * Every settings page of Section 4.5.6, org and personal: the section header, the page's
 * registered settings with their source, then the panels modules contribute to the page. A page
 * with neither yet shows its specific empty state naming the next action.
 */
export async function SettingsSectionPage({ node, params }: { node: string; params: Params }) {
  const ctx = await requireNode(node, params);
  const group = node.startsWith("me.") ? "personal" : "org";
  const panels = CONTRIBUTIONS.filter((c) => c.node === node).sort((a, b) => a.order - b.order);
  const hasSettings = pageSettings(node, group).length > 0;
  if (!hasSettings && panels.length === 0) {
    const t = await getTranslate();
    const copy = pageCopyKey(node);
    return (
      <>
        <SectionHeader node={node} />
        <EmptyStateLink
          icon="Settings"
          sentence={t(`${copy}.empty`)}
          actionLabel={t(`${copy}.action`)}
          href={emptyStateHref(node, params, ctx.nav)}
        />
      </>
    );
  }
  return (
    <>
      <SectionHeader node={node} />
      <RegistrySection ctx={ctx} node={node} group={group} />
      {panels.map(({ Panel }, index) => (
        <Panel key={`${node}-${index}`} ctx={ctx} params={params} />
      ))}
    </>
  );
}
