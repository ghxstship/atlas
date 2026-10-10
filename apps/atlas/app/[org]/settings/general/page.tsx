import { GeneralForm } from "@/components/settings/forms";
import { SectionHeader } from "@/components/settings/section-header";
import { requireNode } from "@/components/shell/sitemap-page";

/**
 * General (Section 4.5.6, item 2): the org name, written through the column grant on
 * app.organizations. Legal name, logo, default workspace and default landing page need columns or
 * settings rows that do not exist yet (A30, settings registry).
 */
export default async function GeneralSettingsPage({
  params,
}: PageProps<"/[org]/settings/general">) {
  const ctx = await requireNode("settings.general", await params);
  return (
    <>
      <SectionHeader node="settings.general" />
      <GeneralForm org={ctx.org.slug} name={ctx.org.name} />
    </>
  );
}
