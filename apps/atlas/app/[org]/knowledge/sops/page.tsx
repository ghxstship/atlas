import { requireNode } from "@/lib/shell/require-node";
import { SopsSection } from "@/components/knowledge/sops";
import { nodeHref } from "@/lib/shell/sitemap";

/** Knowledge > SOPs (Section 4.5.5). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/knowledge/sops">) {
  const routeParams = await params;
  const ctx = await requireNode("knowledge.sops", routeParams);
  return (
    <SopsSection
      ctx={ctx}
      path={nodeHref("knowledge.sops", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
