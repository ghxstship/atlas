import { notFound } from "next/navigation";
import { DocumentsSection } from "@/components/knowledge/documents";
import { BooksSection } from "@/components/projects/books";
import { ProjectInboxSection } from "@/components/projects/project-inbox";
import { requireNode } from "@/lib/shell/require-node";
import { getProjectContextFor } from "@/lib/projects/context";
import { nodeHref } from "@/lib/shell/sitemap";

/**
 * The project Documents tab (Section 4.5.4): the project's documents and their versions, the project's books of
 * show documents (B7, ADR 0146), then the project inbox (Section 4.6.5) for people who file documents on the project.
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
  return (
    <>
      <DocumentsSection
        ctx={ctx}
        path={path}
        search={search}
        projectId={project.project.id}
        canWriteProject={project.capabilities.has("knowledge.document.write")}
      />
      <BooksSection ctx={project} />
      <ProjectInboxSection ctx={project} showAll={search["inbox"] === "all"} path={path} />
    </>
  );
}
