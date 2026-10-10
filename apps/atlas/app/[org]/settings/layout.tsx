import { getNode, isNodeVisible } from "@xos/ia";
import { SectionNav } from "@/components/shell/section-nav";
import { requireNode } from "@/components/shell/sitemap-page";
import { TemplateSettings } from "@/components/ui";
import { navigableChildren, nodeHref, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Org settings (Settings template, Section 11.6): the sections of Section 4.5.6 the viewer may open,
 * in order, beside the form column. Admins never see Billing and Plan or Legal (ADR 0006 item 4).
 */
export default async function SettingsLayout({ children, params }: LayoutProps<"/[org]/settings">) {
  const routeParams = await params;
  const ctx = await requireNode("settings", routeParams);
  const t = await getTranslate();
  const sections = navigableChildren(getNode(sitemap, "settings").node)
    .filter((s) => isNodeVisible(sitemap, s.id, ctx.nav))
    .flatMap((s) => {
      const href = nodeHref(s.id, routeParams);
      return href ? [{ id: s.id, label: t(s.label), href }] : [];
    });
  return (
    <TemplateSettings
      sections={<SectionNav label={t("shell.settings.sections")} sections={sections} />}
    >
      {children}
    </TemplateSettings>
  );
}
