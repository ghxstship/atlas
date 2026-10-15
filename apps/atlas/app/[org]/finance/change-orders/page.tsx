import { ChangeOrdersView } from "@/components/finance/change-orders-view";
import { loadFinancePage } from "@/lib/finance/context";

/** Finance > Change orders (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/finance/change-orders">) {
  const page = await loadFinancePage("finance.change-orders", await params, await searchParams);
  return <ChangeOrdersView page={page} />;
}
