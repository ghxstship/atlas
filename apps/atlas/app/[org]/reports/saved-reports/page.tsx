import { SavedReportsView } from "@/components/reports/saved-view";
import { loadFinancePage } from "@/lib/finance/context";

/** Reports > Saved reports: run and share A18's report definitions. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/reports/saved-reports">) {
  const page = await loadFinancePage("reports.saved-reports", await params, await searchParams);
  return <SavedReportsView page={page} />;
}
