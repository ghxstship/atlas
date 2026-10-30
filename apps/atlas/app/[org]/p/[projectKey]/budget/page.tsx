import { BudgetsView } from "@/components/finance/budgets-view";
import { LiveList } from "@/components/live/live-list";
import { loadProjectTab } from "@/lib/finance/context";

/** The project Budget tab (Section 4.5.4): the project's budgets in the Finance budget views. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/budget">) {
  const routeParams = await params;
  const page = await loadProjectTab(
    "project.budget",
    "finance.budgets",
    routeParams,
    await searchParams,
  );
  return (
    <>
      <LiveList org={routeParams.org} tables={["budgets"]} />
      <BudgetsView page={page} />
    </>
  );
}
