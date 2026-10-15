import { redirect } from "next/navigation";
import { requireNode } from "@/lib/shell/sitemap";

/** Company settings open on the company profile (visible only while acting for an account). */
export default async function CompanySettingsPage() {
  await requireNode("settings.company");
  redirect("/settings/company/company-profile-and-privacy");
}
