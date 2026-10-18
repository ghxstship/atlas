import { requireNode } from "@/lib/shell/require-node";
import { CatalogSection } from "@/components/procurement/catalog";
import { nodeHref } from "@/lib/shell/sitemap";

/** Procurement > Catalog (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/procurement/catalog">) {
  const routeParams = await params;
  const ctx = await requireNode("procurement.catalog", routeParams);
  return (
    <CatalogSection
      ctx={ctx}
      path={nodeHref("procurement.catalog", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
