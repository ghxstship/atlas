import { requireNode } from "@/components/shell/sitemap-page";
import { FormsSection } from "@/components/workforce/forms";
import { nodeHref } from "@/lib/shell/sitemap";

/** Knowledge > Forms (Section 4.9 Forms). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/knowledge/forms">) {
  const routeParams = await params;
  const ctx = await requireNode("knowledge.forms", routeParams);
  return (
    <FormsSection
      ctx={ctx}
      path={nodeHref("knowledge.forms", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
