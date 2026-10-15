import { IncidentsReport } from "@/components/reports/views";
import { loadFinancePage } from "@/lib/finance/context";

/** Reports > Incidents (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/reports/incidents">) {
  const page = await loadFinancePage("reports.incidents", await params, await searchParams);
  return <IncidentsReport page={page} />;
}
