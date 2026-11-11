import { requireNode } from "@/lib/shell/require-node";
import { PurchaseOrdersSection } from "@/components/procurement/purchase-orders";
import { nodeHref } from "@/lib/shell/sitemap";
import { LiveList } from "@/components/live/live-list";

/** Procurement > Purchase orders (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/procurement/purchase-orders">) {
  const routeParams = await params;
  const ctx = await requireNode("procurement.purchase-orders", routeParams);
  return (
    <>
      <LiveList org={routeParams.org} tables={["purchase_orders", "po_lines"]} />
      <PurchaseOrdersSection
        ctx={ctx}
        path={nodeHref("procurement.purchase-orders", routeParams) ?? "/"}
        search={await searchParams}
      />
    </>
  );
}
