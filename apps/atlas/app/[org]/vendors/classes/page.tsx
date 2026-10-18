import { requireNode } from "@/lib/shell/require-node";
import { VendorClasses } from "@/components/vendors/classes";
import { nodeHref } from "@/lib/shell/sitemap";

/** Vendors > Classes (Section 4.5.5). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/vendors/classes">) {
  const routeParams = await params;
  const ctx = await requireNode("vendors.classes", routeParams);
  return (
    <VendorClasses
      ctx={ctx}
      path={nodeHref("vendors.classes", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
