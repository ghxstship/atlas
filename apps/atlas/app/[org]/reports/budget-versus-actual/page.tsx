import { BudgetVersusActualReport } from "@/components/reports/views";
import { loadFinancePage } from "@/lib/finance/context";

/** Reports > Budget versus actual (Section 7.4 Analytics). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/reports/budget-versus-actual">) {
  const page = await loadFinancePage(
    "reports.budget-versus-actual",
    await params,
    await searchParams,
  );
  return <BudgetVersusActualReport page={page} />;
}
