import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ReacceptanceBanner } from "@/components/legal/reacceptance-banner";
import { AppShell } from "@/components/shell/app-shell";
import { ShellPeek } from "@/components/shell/shell-peek";
import { getTranslations } from "next-intl/server";
import { OrgBanners } from "@/components/platform/org-banners";
import { SystemBanners } from "@/components/shell/system-banners";
import { SandboxBanner } from "@/components/sandbox/sandbox-banner";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Every org route renders inside the Atlas shell, under the platform's system banners (A90), which load after the
 * page. A person who is not an active member of the org,
 * or an org that does not exist, gets 404 (ADR 0003); signed-out visitors were already sent to
 * sign in by the proxy. The shell's `?peek={recordKey}` hook opens a record in the side peek on any
 * route that does not peek its own rows (Section 4.5.3). Those who accept legal terms for the org
 * see the re-acceptance prompt after a material change (Section 14.4, A82).
 */
export default async function OrgLayout({ children, params }: LayoutProps<"/[org]">) {
  const { org } = await params;
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  const t = await getTranslations("shell.systemBanner");
  return (
    <AppShell ctx={ctx}>
      <SystemBanners linkLabel={t("details")} />
      <OrgBanners ctx={ctx} />
      <SandboxBanner ctx={ctx} />
      <ReacceptanceBanner ctx={ctx} />
      {children}
      <Suspense fallback={null}>
        <ShellPeek org={ctx.org.slug} />
      </Suspense>
    </AppShell>
  );
}
