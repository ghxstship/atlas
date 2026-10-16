import { requireNode } from "@/components/shell/sitemap-page";
import { LostFoundSection } from "@/components/workforce/lost-found";
import { nodeHref } from "@/lib/shell/sitemap";

/** Site Operations > Lost and Found (Section 4.9 lost and found log). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/site-ops/lost-and-found">) {
  const routeParams = await params;
  const ctx = await requireNode("site-ops.lost-and-found", routeParams);
  return (
    <LostFoundSection
      ctx={ctx}
      path={nodeHref("site-ops.lost-and-found", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
