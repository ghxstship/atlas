import { MeasurementReport } from "@/components/measurement/report";
import { loadFinancePage } from "@/lib/finance/context";

/**
 * Reports > Objectives and Measurement (A98, Section 4.10): gate 1 objectives against what gate 8 measured, for one
 * project (`?project=KEY`) or rolled up across the org.
 */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/reports/measurement">) {
  const page = await loadFinancePage("reports.measurement", await params, await searchParams);
  return <MeasurementReport page={page} />;
}
