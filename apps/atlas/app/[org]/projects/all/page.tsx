import { ProjectsPage } from "@/components/projects/projects-page";
import { LiveList } from "@/components/live/live-list";

/** Projects > All projects (Section 4.5.5): table, list, board and gallery. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/projects/all">) {
  const routeParams = await params;
  return (
    <>
      <LiveList org={routeParams.org} tables={["projects"]} />
      <ProjectsPage node="projects.all" params={routeParams} searchParams={await searchParams} />
    </>
  );
}
