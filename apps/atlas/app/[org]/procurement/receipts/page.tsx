import { requireNode } from "@/lib/shell/require-node";
import { ReceiptsSection } from "@/components/procurement/receipts";
import { nodeHref } from "@/lib/shell/sitemap";
import { LiveList } from "@/components/live/live-list";

/** Procurement > Receipts (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/procurement/receipts">) {
  const routeParams = await params;
  const ctx = await requireNode("procurement.receipts", routeParams);
  return (
    <>
      <LiveList org={routeParams.org} tables={["goods_receipts"]} />
      <ReceiptsSection
        ctx={ctx}
        path={nodeHref("procurement.receipts", routeParams) ?? "/"}
        search={await searchParams}
      />
    </>
  );
}
