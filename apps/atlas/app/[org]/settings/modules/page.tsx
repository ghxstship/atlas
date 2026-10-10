import { getTranslations } from "next-intl/server";
import { SectionHeader } from "@/components/settings/section-header";
import { requireNode } from "@/components/shell/sitemap-page";
import { InlineAlert, Switch } from "@/components/ui";
import { sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Modules (Section 4.5.2 and 4.5.6 item 13). The list comes from the sitemap's module keys; a module
 * that is off leaves navigation, search and the command menu through NavContext.disabledModules,
 * which the shell already honors. Storing the choice needs an org module settings table that
 * migrations 0200 to 0207 do not have, so every switch shows the module on and cannot change yet.
 */
function moduleNodes() {
  const out: { module: string; label: string }[] = [];
  const walk = (nodes: typeof sitemap.nodes) => {
    for (const n of nodes) {
      if (n.module && n.kind === "item") out.push({ module: n.module, label: n.label });
      if (n.children) walk(n.children);
    }
  };
  walk(sitemap.nodes);
  return out;
}

export default async function ModulesSettingsPage({
  params,
}: PageProps<"/[org]/settings/modules">) {
  await requireNode("settings.modules", await params);
  const [t, translate] = await Promise.all([
    getTranslations("shell.settings.modules"),
    getTranslate(),
  ]);
  return (
    <>
      <SectionHeader node="settings.modules" />
      <InlineAlert tone="warning">{t("notStored")}</InlineAlert>
      <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
        {moduleNodes().map((m) => (
          <li key={m.module} className="py-8">
            <Switch
              label={translate(m.label)}
              checked
              disabled
              readOnly
              name={`module-${m.module}`}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
