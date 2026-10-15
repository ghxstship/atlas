import { CostCentersView } from "@/components/finance/reference-views";
import { loadFinancePage } from "@/lib/finance/context";

/** Finance > Cost centers (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/finance/cost-centers">) {
  const page = await loadFinancePage("finance.cost-centers", await params, await searchParams);
  return <CostCentersView page={page} />;
}
