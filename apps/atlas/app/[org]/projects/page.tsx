import { ProjectsPage } from "@/components/projects/projects-page";

/** Projects (Section 4.5.2): every project the viewer may read, in the view they choose. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/projects">) {
  return <ProjectsPage node="projects" params={await params} searchParams={await searchParams} />;
}
