import { BudgetsView } from "@/components/finance/budgets-view";
import { LiveList } from "@/components/live/live-list";
import { loadFinancePage } from "@/lib/finance/context";

/** Finance > Budgets (Section 4.5.5): every readable budget, its grid and its matrix. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/finance/budgets">) {
  const routeParams = await params;
  const page = await loadFinancePage("finance.budgets", routeParams, await searchParams);
  return (
    <>
      <LiveList org={routeParams.org} tables={["budgets"]} />
      <BudgetsView page={page} />
    </>
  );
}
