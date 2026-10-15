import { redirect } from "next/navigation";
import { requireNode } from "@/lib/shell/sitemap";

/** Settings opens on its first section, Profile. */
export default async function SettingsPage() {
  await requireNode("settings");
  redirect("/settings/profile");
}
