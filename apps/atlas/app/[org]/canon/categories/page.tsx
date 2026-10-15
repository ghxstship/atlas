import { requireNode } from "@/components/shell/sitemap-page";
import { CanonCategories } from "@/components/canon/browser";
import { nodeHref } from "@/lib/shell/sitemap";

/** Canon > Categories (Section 4.5.5). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/canon/categories">) {
  const routeParams = await params;
  const ctx = await requireNode("canon.categories", routeParams);
  return (
    <CanonCategories
      ctx={ctx}
      path={nodeHref("canon.categories", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
