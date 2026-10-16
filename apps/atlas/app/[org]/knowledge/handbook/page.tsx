import { requireNode } from "@/components/shell/sitemap-page";
import { HandbookSection } from "@/components/workforce/handbook";
import { nodeHref } from "@/lib/shell/sitemap";

/** Knowledge > Handbook (Section 4.9 Handbook and SOPs). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/knowledge/handbook">) {
  const routeParams = await params;
  const ctx = await requireNode("knowledge.handbook", routeParams);
  return (
    <HandbookSection
      ctx={ctx}
      path={nodeHref("knowledge.handbook", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
