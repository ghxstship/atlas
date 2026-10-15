import { requireNode } from "@/components/shell/sitemap-page";
import { CanonExtensions } from "@/components/canon/extensions";
import { nodeHref } from "@/lib/shell/sitemap";

/** Canon > Org extensions (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/canon/org-extensions">) {
  const routeParams = await params;
  const ctx = await requireNode("canon.org-extensions", routeParams);
  return (
    <CanonExtensions
      ctx={ctx}
      path={nodeHref("canon.org-extensions", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
