import { requireNode } from "@/lib/shell/require-node";
import { ReportBuilderView } from "@/components/workflow/report-builder-view";

/** Reports builder (A33): build, preview, save and run reports on A18's report definitions. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/reports/builder">) {
  const ctx = await requireNode("reports.builder", await params);
  const report = (await searchParams)["report"];
  const reportId = typeof report === "string" && /^[0-9a-f-]{36}$/.test(report) ? report : null;
  return <ReportBuilderView ctx={ctx} reportId={reportId} />;
}
