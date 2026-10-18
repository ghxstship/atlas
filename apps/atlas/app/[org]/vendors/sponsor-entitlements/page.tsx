import { requireNode } from "@/lib/shell/require-node";
import { SponsorEntitlements } from "@/components/vendors/entitlements";
import { nodeHref } from "@/lib/shell/sitemap";

/** Vendors > Sponsor entitlements (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/vendors/sponsor-entitlements">) {
  const routeParams = await params;
  const ctx = await requireNode("vendors.sponsor-entitlements", routeParams);
  return (
    <SponsorEntitlements
      ctx={ctx}
      path={nodeHref("vendors.sponsor-entitlements", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
