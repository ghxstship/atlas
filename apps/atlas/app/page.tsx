import { cookies } from "next/headers";
import type { Metadata, Route } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PublicHome } from "@/components/public-home";
import { LAST_ORG_COOKIE } from "@/lib/shell/last-org";
import { getOrgWorkspaces } from "@/lib/shell/active-workspace";
import { getMyOrganizations, getViewer } from "@/lib/shell/context";
import { getShellSettings, startPath } from "@/lib/shell/org-settings";

/** Pages the installed app's shortcuts open (`/?open=inbox`). */
const APP_SHORTCUTS = ["inbox", "my-work", "projects"] as const;

/** The public homepage's title and description, which search engines and Google's OAuth review read. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell.landing");
  return { title: { absolute: t("brand") }, description: t("lead") };
}

/**
 * Entry. A signed-in person goes to the start page (shell.start_page: Home, My Work, Inbox or
 * Projects) of the org they used last (or their first org), as it applies in the workspace their filter
 * chose (a workspace value beats the org's, Section 4.5.6), and a person with no org creates one.
 * Everyone else sees the public homepage, which says what XOS is, leads to sign in and links the
 * legal documents (RRR-248). An email link or an OAuth sign-in that fell back to the site root
 * (Supabase Auth's Site URL) still completes through /auth/callback, which also shows the error such
 * a return can carry.
 */
export default async function EntryPage({ searchParams }: PageProps<"/">) {
  const query = await searchParams;
  const returned = new URLSearchParams();
  for (const name of ["code", "sb_flow_id", "error", "error_code"] as const) {
    const value = query[name];
    if (typeof value === "string") returned.set(name, value);
  }
  if (returned.has("code") || returned.has("error") || returned.has("error_code")) {
    redirect(`/auth/callback?${returned.toString()}`);
  }
  const viewer = await getViewer();
  if (!viewer) return <PublicHome />;
  const orgs = await getMyOrganizations();
  if (orgs.length === 0) redirect("/auth/organization");
  const last = (await cookies()).get(LAST_ORG_COOKIE)?.value;
  const org = orgs.find((o) => o.slug === last) ?? orgs[0];
  if (!org) redirect("/auth/organization");
  // The installed app's shortcuts (app/manifest.ts, A96) open a page of the org used last.
  const open = query["open"];
  if (typeof open === "string" && (APP_SHORTCUTS as readonly string[]).includes(open)) {
    redirect(`/${org.slug}/${open}` as Route);
  }
  const { active } = await getOrgWorkspaces(viewer.db, org.id);
  const settings = await getShellSettings(viewer.db, org.id, active?.id ?? null);
  redirect(startPath(org.slug, settings.startPage) as Route);
}
