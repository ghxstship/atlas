import { requireNode } from "@/lib/shell/require-node";
import { VendorDirectory } from "@/components/vendors/directory";
import { nodeHref } from "@/lib/shell/sitemap";

/** Vendors > Directory (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/vendors/directory">) {
  const routeParams = await params;
  const ctx = await requireNode("vendors.directory", routeParams);
  return (
    <VendorDirectory
      ctx={ctx}
      path={nodeHref("vendors.directory", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
