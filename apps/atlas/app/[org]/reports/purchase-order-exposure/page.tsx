import { PurchaseOrderExposureReport } from "@/components/reports/views";
import { loadFinancePage } from "@/lib/finance/context";

/** Reports > Purchase order exposure (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/reports/purchase-order-exposure">) {
  const page = await loadFinancePage(
    "reports.purchase-order-exposure",
    await params,
    await searchParams,
  );
  return <PurchaseOrderExposureReport page={page} />;
}
