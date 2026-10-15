import { FinalCostReport } from "@/components/reports/views";
import { loadFinancePage } from "@/lib/finance/context";

/** Reports > Final cost report against the gate 3 baseline (journey 23). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/reports/final-cost-report">) {
  const page = await loadFinancePage("reports.final-cost-report", await params, await searchParams);
  return <FinalCostReport page={page} />;
}
