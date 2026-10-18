import { notFound } from "next/navigation";
import { DocumentsSection } from "@/components/knowledge/documents";
import { requireNode } from "@/lib/shell/require-node";
import { getProjectContextFor } from "@/lib/projects/context";
import { nodeHref } from "@/lib/shell/sitemap";

/** The project Documents tab (Section 4.5.4): the project's documents and their versions. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/documents">) {
  const routeParams = await params;
  const ctx = await requireNode("project.documents", routeParams);
  const project = await getProjectContextFor(routeParams);
  if (!project) notFound();
  return (
    <DocumentsSection
      ctx={ctx}
      path={nodeHref("project.documents", routeParams) ?? "/"}
      search={await searchParams}
      projectId={project.project.id}
      canWriteProject={project.capabilities.has("knowledge.document.write")}
    />
  );
}
