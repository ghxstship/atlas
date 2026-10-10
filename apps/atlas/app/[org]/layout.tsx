import { notFound } from "next/navigation";
import { AppShell } from "@/components/shell/app-shell";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Every org route renders inside the Atlas shell. A person who is not an active member of the org,
 * or an org that does not exist, gets 404 (ADR 0003); signed-out visitors were already sent to
 * sign in by the proxy.
 */
export default async function OrgLayout({ children, params }: LayoutProps<"/[org]">) {
  const { org } = await params;
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  return <AppShell ctx={ctx}>{children}</AppShell>;
}
