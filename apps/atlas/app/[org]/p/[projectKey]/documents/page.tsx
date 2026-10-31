import { notFound } from "next/navigation";
import { GovernanceDraftEntry } from "@/components/aurora/entry/answers-entry";
import { DocumentsSection } from "@/components/knowledge/documents";
import { ProjectInboxSection } from "@/components/projects/project-inbox";
import { requireNode } from "@/lib/shell/require-node";
import { getProjectContextFor } from "@/lib/projects/context";
import { nodeHref } from "@/lib/shell/sitemap";

/**
 * The project Documents tab (Section 4.5.4): the project's documents and their versions, then the
 * project inbox (Section 4.6.5) for people who file documents on the project.
 */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/documents">) {
  const routeParams = await params;
  const ctx = await requireNode("project.documents", routeParams);
  const project = await getProjectContextFor(routeParams);
  if (!project) notFound();
  const search = await searchParams;
  const path = nodeHref("project.documents", routeParams) ?? "/";
  const canWrite = project.capabilities.has("knowledge.document.write");
  return (
    <>
      {canWrite ? (
        <GovernanceDraftEntry
          org={project.org.org.slug}
          projectId={project.project.id}
          projectKey={project.project.key}
          projectName={project.project.name}
        />
      ) : null}
      <DocumentsSection
        ctx={ctx}
        path={path}
        search={search}
        projectId={project.project.id}
        canWriteProject={canWrite}
      />
      <ProjectInboxSection ctx={project} showAll={search["inbox"] === "all"} path={path} />
    </>
  );
}
