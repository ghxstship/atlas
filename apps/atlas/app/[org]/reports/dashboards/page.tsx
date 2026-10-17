import { DashboardsView } from "@/components/reports/dashboards-view";
import { loadFinancePage } from "@/lib/finance/context";

/** Reports > Dashboards: saved reports on a 12-column grid (A43, A38-004, journey 29). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/reports/dashboards">) {
  const page = await loadFinancePage("reports.dashboards", await params, await searchParams);
  return <DashboardsView page={page} />;
}
