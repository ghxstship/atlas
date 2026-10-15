import { BudgetsView } from "@/components/finance/budgets-view";
import { loadProjectTab } from "@/lib/finance/context";

/** The project Budget tab (Section 4.5.4): the project's budgets in the Finance budget views. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/budget">) {
  const page = await loadProjectTab(
    "project.budget",
    "finance.budgets",
    await params,
    await searchParams,
  );
  return <BudgetsView page={page} />;
}
