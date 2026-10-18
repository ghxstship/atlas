import { requireNode } from "@/lib/shell/require-node";
import { RfqsSection } from "@/components/procurement/rfqs";
import { nodeHref } from "@/lib/shell/sitemap";

/** Procurement > RFQs (Section 4.5.5). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/procurement/rfqs">) {
  const routeParams = await params;
  const ctx = await requireNode("procurement.rfqs", routeParams);
  return (
    <RfqsSection
      ctx={ctx}
      path={nodeHref("procurement.rfqs", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
