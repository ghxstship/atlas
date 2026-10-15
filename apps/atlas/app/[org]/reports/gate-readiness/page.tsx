import { GateReadinessReport } from "@/components/reports/views";
import { loadFinancePage } from "@/lib/finance/context";

/** Reports > Gate readiness (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/reports/gate-readiness">) {
  const page = await loadFinancePage("reports.gate-readiness", await params, await searchParams);
  return <GateReadinessReport page={page} />;
}
