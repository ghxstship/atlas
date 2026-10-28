import { requireNode } from "@/lib/shell/require-node";
import { RfqsSection } from "@/components/procurement/rfqs";
import { nodeHref } from "@/lib/shell/sitemap";
import { LiveList } from "@/components/live/live-list";

/** Procurement > RFQs (Section 4.5.5). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/procurement/rfqs">) {
  const routeParams = await params;
  const ctx = await requireNode("procurement.rfqs", routeParams);
  return (
    <>
      <LiveList org={routeParams.org} tables={["rfqs"]} />
      <RfqsSection
        ctx={ctx}
        path={nodeHref("procurement.rfqs", routeParams) ?? "/"}
        search={await searchParams}
      />
    </>
  );
}
