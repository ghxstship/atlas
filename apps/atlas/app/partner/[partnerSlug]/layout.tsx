import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { OrgBanners } from "@/components/platform/org-banners";
import { SystemBanners } from "@/components/shell/system-banners";
import { AppShell } from "@/components/shell/app-shell";
import { getOrgContext } from "@/lib/shell/context";

/**
 * The partner console (Section 4.6.1) renders inside the Atlas shell of the partner org. A person who
 * is not an active member of the partner org gets 404 (ADR 0003); each page checks its own node's
 * visibility (Owner and Admin; wholesale billing Owner only, ADR 0006 item 5).
 */
export default async function PartnerLayout({
  children,
  params,
}: LayoutProps<"/partner/[partnerSlug]">) {
  const { partnerSlug } = await params;
  const ctx = await getOrgContext(partnerSlug);
  if (!ctx) notFound();
  const t = await getTranslations("shell.systemBanner");
  return (
    <AppShell ctx={ctx}>
      <SystemBanners linkLabel={t("details")} />
      <OrgBanners ctx={ctx} />
      {children}
    </AppShell>
  );
}
