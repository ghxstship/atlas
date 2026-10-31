import { intakeTermOptions, readsPayroll } from "@xos/data/ai";
import { notFound } from "next/navigation";
import { ContractIntakeEntry } from "@/components/aurora/entry/intake-entry";
import { EngagementsView } from "@/components/opportunities/engagements-view";
import { setupPage, type SearchParams } from "@/lib/opportunities/page";
import { getProjectContextFor } from "@/lib/projects/context";
import { nodeHref } from "@/lib/shell/sitemap";

/**
 * The project Engagements tab (Section 4.5.4, twin of Opportunities > Engagements): the external engagements of this
 * project only. A project the viewer may not read answers 404 (invariant 2).
 */
export default async function ProjectEngagementsPage({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/engagements">) {
  const routeParams = await params;
  const project = await getProjectContextFor(routeParams);
  if (!project) notFound();
  const page = await setupPage(
    "project.engagements",
    routeParams,
    (await searchParams) as SearchParams,
    project.org,
  );
  // B15 contract intake: shown to those who book acts and write riders on the project; the terms come
  // from canon rate cards, the fee column from the database's answer on pay rates.
  const books =
    project.capabilities.has("opportunities.engagement.write") &&
    project.capabilities.has("advancing.rider.write");
  const db = project.org.viewer.db;
  const [terms, payroll] = books
    ? await Promise.all([intakeTermOptions(db), readsPayroll(db, project.project.id)])
    : [null, null];
  return (
    <>
      {terms?.ok ? (
        <ContractIntakeEntry
          projectId={project.project.id}
          terms={terms.data}
          readsPayroll={payroll?.ok === true && payroll.data}
        />
      ) : null}
      <EngagementsView
        page={page}
        projectId={project.project.id}
        emptyHref={nodeHref("opportunities.postings", routeParams) ?? page.base}
      />
    </>
  );
}
