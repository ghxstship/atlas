import { requireNode } from "@/components/shell/sitemap-page";
import { VerbiageSection } from "@/components/knowledge/verbiage";
import { nodeHref } from "@/lib/shell/sitemap";

/** Knowledge > Verbiage library (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/knowledge/verbiage-library">) {
  const routeParams = await params;
  const ctx = await requireNode("knowledge.verbiage-library", routeParams);
  return (
    <VerbiageSection
      ctx={ctx}
      path={nodeHref("knowledge.verbiage-library", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
