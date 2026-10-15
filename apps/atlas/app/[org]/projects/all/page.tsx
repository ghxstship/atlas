import { ProjectsPage } from "@/components/projects/projects-page";

/** Projects > All projects (Section 4.5.5): table, list, board and gallery. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/projects/all">) {
  return (
    <ProjectsPage node="projects.all" params={await params} searchParams={await searchParams} />
  );
}
