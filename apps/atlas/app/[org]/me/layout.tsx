import { getNode, isNodeVisible } from "@xos/ia";
import { SectionNav } from "@/components/shell/section-nav";
import { requireNode } from "@/components/shell/sitemap-page";
import { TemplateSettings } from "@/components/ui";
import { navigableChildren, nodeHref, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Personal settings (Settings template, Section 11.6): the personal sections of Section 4.5.6 the
 * viewer may open, in order, beside the form column. One set of settings, shared with Gateway and
 * Compass.
 */
export default async function PersonalSettingsLayout({
  children,
  params,
}: LayoutProps<"/[org]/me">) {
  const routeParams = await params;
  const ctx = await requireNode("me", routeParams);
  const t = await getTranslate();
  const sections = navigableChildren(getNode(sitemap, "me").node)
    .filter((s) => isNodeVisible(sitemap, s.id, ctx.nav))
    .flatMap((s) => {
      const href = nodeHref(s.id, routeParams);
      return href ? [{ id: s.id, label: t(s.label), href }] : [];
    });
  return (
    <TemplateSettings
      sections={<SectionNav label={t("settings.personalSections")} sections={sections} />}
    >
      {children}
    </TemplateSettings>
  );
}
