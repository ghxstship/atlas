import { notFound } from "next/navigation";
import { SavedReportsView } from "@/components/reports/saved-view";
import { WrapUpSection } from "@/components/reports/wrap-up";
import { loadProjectTab } from "@/lib/finance/context";
import { getProjectContextFor } from "@/lib/projects/context";

/**
 * The project Reports tab (Section 4.5.4): the project's wrap-up (B7, ADR 0146), then the built-in reports for the
 * project and its shared reports.
 */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/reports">) {
  const routeParams = await params;
  const page = await loadProjectTab(
    "project.reports",
    "reports.saved-reports",
    routeParams,
    await searchParams,
  );
  const project = await getProjectContextFor(routeParams);
  if (!project) notFound();
  return (
    <>
      <WrapUpSection ctx={project} />
      <SavedReportsView page={page} />
    </>
  );
}
