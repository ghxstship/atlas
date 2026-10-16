import { requireNode } from "@/components/shell/sitemap-page";
import { DocumentsSection } from "@/components/knowledge/documents";
import { nodeHref } from "@/lib/shell/sitemap";

/** Knowledge > Documents (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/knowledge/documents">) {
  const routeParams = await params;
  const ctx = await requireNode("knowledge.documents", routeParams);
  return (
    <DocumentsSection
      ctx={ctx}
      path={nodeHref("knowledge.documents", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
