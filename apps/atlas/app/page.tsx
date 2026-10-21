import { cookies } from "next/headers";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { LAST_ORG_COOKIE } from "@/lib/shell/last-org";
import { getOrgWorkspaces } from "@/lib/shell/active-workspace";
import { getMyOrganizations, getViewer } from "@/lib/shell/context";
import { getShellSettings, startPath } from "@/lib/shell/org-settings";

/**
 * Entry. A signed-in person goes to the start page (shell.start_page: Home, My Work, Inbox or
 * Projects) of the org they used last (or their first org), as it applies in the workspace their filter
 * chose (a workspace value beats the org's, Section 4.5.6), a person with no org creates one, and
 * everyone else signs in. An email link or an OAuth sign-in that fell back to the site root
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
  if (!viewer) redirect("/auth/sign-in");
  const orgs = await getMyOrganizations();
  if (orgs.length === 0) redirect("/auth/organization");
  const last = (await cookies()).get(LAST_ORG_COOKIE)?.value;
  const org = orgs.find((o) => o.slug === last) ?? orgs[0];
  if (!org) redirect("/auth/organization");
  const { active } = await getOrgWorkspaces(viewer.db, org.id);
  const settings = await getShellSettings(viewer.db, org.id, active?.id ?? null);
  redirect(startPath(org.slug, settings.startPage) as Route);
}
