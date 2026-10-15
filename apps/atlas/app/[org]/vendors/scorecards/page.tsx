import { requireNode } from "@/components/shell/sitemap-page";
import { VendorScorecards } from "@/components/vendors/scorecards";
import { nodeHref } from "@/lib/shell/sitemap";

/** Vendors > Scorecards (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/vendors/scorecards">) {
  const routeParams = await params;
  const ctx = await requireNode("vendors.scorecards", routeParams);
  return (
    <VendorScorecards
      ctx={ctx}
      path={nodeHref("vendors.scorecards", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
