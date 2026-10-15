import { ExpensesView } from "@/components/finance/expenses-view";
import { loadFinancePage } from "@/lib/finance/context";

/** Finance > Expenses (Section 4.5.5). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/finance/expenses">) {
  const page = await loadFinancePage("finance.expenses", await params, await searchParams);
  return <ExpensesView page={page} />;
}
