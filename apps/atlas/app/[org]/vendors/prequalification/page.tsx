import { requireNode } from "@/lib/shell/require-node";
import { VendorPrequalification } from "@/components/vendors/prequalification";
import { nodeHref } from "@/lib/shell/sitemap";

/** Vendors > Prequalification (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/vendors/prequalification">) {
  const routeParams = await params;
  const ctx = await requireNode("vendors.prequalification", routeParams);
  return (
    <VendorPrequalification
      ctx={ctx}
      path={nodeHref("vendors.prequalification", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
