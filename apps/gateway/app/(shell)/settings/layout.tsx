import { getNode, isNodeVisible } from "@xos/ia";
import type { ReactNode } from "react";
import { SettingsNav } from "@/components/settings/settings-nav";
import { TemplateSettings } from "@/components/ui";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Settings (Section 4.5.8 avatar menu, Section 11.6 Settings template): the section list from the
 * sitemap beside a centered form column. Company sections appear when the person acts for an
 * external account, filtered by their account role.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const ctx = await requireNode("settings");
  const t = await getTranslate();
  const sections = (getNode(sitemap, "settings").node.children ?? []).filter((c) => c.kind === "section" && isNodeVisible(sitemap, c.id, ctx.nav));
  const groups = [
    {
      label: t("nav.gateway.avatar.settings"),
      items: sections.filter((s) => s.id !== "settings.company").map((s) => ({ id: s.id, label: t(s.label), href: s.route ?? "/settings" })),
    },
    ...(sections.some((s) => s.id === "settings.company")
      ? [
          {
            label: t("nav.gateway.avatar.companySettings"),
            items: (getNode(sitemap, "settings.company").node.children ?? [])
              .filter((c) => isNodeVisible(sitemap, c.id, ctx.nav))
              .map((c) => ({ id: c.id, label: t(c.label), href: c.route ?? "/settings/company" })),
          },
        ]
      : []),
  ];
  return <TemplateSettings sections={<SettingsNav label={t("nav.gateway.avatar.settings")} groups={groups} />}>{children}</TemplateSettings>;
}
