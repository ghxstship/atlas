import { LaborReport } from "@/components/reports/views";
import { loadFinancePage } from "@/lib/finance/context";

/** Reports > Labor (Section 4.5.5). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/reports/labor">) {
  const page = await loadFinancePage("reports.labor", await params, await searchParams);
  return <LaborReport page={page} />;
}
