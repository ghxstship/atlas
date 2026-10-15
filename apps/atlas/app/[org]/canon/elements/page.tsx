import { requireNode } from "@/components/shell/sitemap-page";
import { CanonElements } from "@/components/canon/elements";
import { nodeHref } from "@/lib/shell/sitemap";

/** Canon > Elements (Section 4.5.5). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/canon/elements">) {
  const routeParams = await params;
  const ctx = await requireNode("canon.elements", routeParams);
  return (
    <CanonElements
      ctx={ctx}
      path={nodeHref("canon.elements", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
