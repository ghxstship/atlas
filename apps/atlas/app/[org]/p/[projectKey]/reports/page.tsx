import { SavedReportsView } from "@/components/reports/saved-view";
import { loadProjectTab } from "@/lib/finance/context";

/** The project Reports tab (Section 4.5.4): the built-in reports for the project and its shared reports. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/reports">) {
  const page = await loadProjectTab(
    "project.reports",
    "reports.saved-reports",
    await params,
    await searchParams,
  );
  return <SavedReportsView page={page} />;
}
