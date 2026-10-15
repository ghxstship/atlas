import { requireNode } from "@/components/shell/sitemap-page";
import { CanonJurisdictions } from "@/components/canon/browser";
import { nodeHref } from "@/lib/shell/sitemap";

/** Canon > Jurisdictions and permit rules (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/canon/jurisdictions-and-permit-rules">) {
  const routeParams = await params;
  const ctx = await requireNode("canon.jurisdictions-and-permit-rules", routeParams);
  return (
    <CanonJurisdictions
      ctx={ctx}
      path={nodeHref("canon.jurisdictions-and-permit-rules", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
