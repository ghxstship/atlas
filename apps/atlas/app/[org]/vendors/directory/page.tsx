import { requireNode } from "@/lib/shell/require-node";
import { VendorDirectory } from "@/components/vendors/directory";
import { SharedSupplierDiversity } from "@/components/vendors/supplier-diversity";
import { nodeHref } from "@/lib/shell/sitemap";
import { LiveList } from "@/components/live/live-list";

/**
 * Vendors > Directory (Section 4.5.5), with the supplier diversity certifications vendors and
 * freelancers shared with the org when it runs a program (Section 4.4.1, A89).
 */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/vendors/directory">) {
  const routeParams = await params;
  const ctx = await requireNode("vendors.directory", routeParams);
  const search = await searchParams;
  return (
    <>
      <LiveList org={routeParams.org} tables={["vendors"]} />
      <VendorDirectory
        ctx={ctx}
        path={nodeHref("vendors.directory", routeParams) ?? "/"}
        search={search}
      />
      {/* Not under an open vendor record, which owns the page then. */}
      {search["peek"] ? null : <SharedSupplierDiversity ctx={ctx} />}
    </>
  );
}
