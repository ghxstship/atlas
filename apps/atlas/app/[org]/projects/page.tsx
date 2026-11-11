import { ProjectsPage } from "@/components/projects/projects-page";
import { LiveList } from "@/components/live/live-list";

/** Projects (Section 4.5.2): every project the viewer may read, in the view they choose. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/projects">) {
  const routeParams = await params;
  return (
    <>
      <LiveList org={routeParams.org} tables={["projects"]} />
      <ProjectsPage node="projects" params={routeParams} searchParams={await searchParams} />
    </>
  );
}
