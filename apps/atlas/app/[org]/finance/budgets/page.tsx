import { BudgetsView } from "@/components/finance/budgets-view";
import { loadFinancePage } from "@/lib/finance/context";

/** Finance > Budgets (Section 4.5.5): every readable budget, its grid and its matrix. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/finance/budgets">) {
  const page = await loadFinancePage("finance.budgets", await params, await searchParams);
  return <BudgetsView page={page} />;
}
