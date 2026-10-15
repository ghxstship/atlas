import type { Metadata } from "next";
import { SettingsSection } from "@/components/settings/sections";
import { getNode } from "@xos/ia";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t(getNode(sitemap, "settings.keyboard-shortcuts").node.label) };
}

/** Settings section settings.keyboard-shortcuts (Section 4.5.8); its content comes from the settings sections. */
export default async function Page() {
  const ctx = await requireNode("settings.keyboard-shortcuts");
  return <SettingsSection node="settings.keyboard-shortcuts" ctx={ctx} />;
}
