import { CoordinateMatrixReport } from "@/components/reports/views";
import { loadFinancePage } from "@/lib/finance/context";

/** Reports > Coordinate matrix: 10 departments by 9 phases (Section 4.2). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/reports/coordinate-matrix">) {
  const page = await loadFinancePage("reports.coordinate-matrix", await params, await searchParams);
  return <CoordinateMatrixReport page={page} />;
}
