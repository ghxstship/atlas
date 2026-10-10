import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LAST_ORG_COOKIE } from "@/lib/shell/last-org";
import { getMyOrganizations, getViewer } from "@/lib/shell/context";

/**
 * Entry. A signed-in person goes to the Home of the org they used last (or their first org), a
 * person with no org creates one, and everyone else signs in. An email link that fell back to the
 * site root still completes through /auth/callback.
 */
export default async function EntryPage({ searchParams }: PageProps<"/">) {
  const code = (await searchParams)["code"];
  if (typeof code === "string") redirect(`/auth/callback?code=${encodeURIComponent(code)}`);
  const viewer = await getViewer();
  if (!viewer) redirect("/auth/sign-in");
  const orgs = await getMyOrganizations();
  if (orgs.length === 0) redirect("/auth/organization");
  const last = (await cookies()).get(LAST_ORG_COOKIE)?.value;
  const org = orgs.find((o) => o.slug === last) ?? orgs[0];
  redirect(`/${org?.slug ?? ""}/home`);
}
