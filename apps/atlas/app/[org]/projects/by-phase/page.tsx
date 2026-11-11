import { ProjectsPage } from "@/components/projects/projects-page";
import { LiveList } from "@/components/live/live-list";

/** Projects > By phase (Section 4.5.5): the board by gate, one column per gated phase. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/projects/by-phase">) {
  const routeParams = await params;
  return (
    <>
      <LiveList org={routeParams.org} tables={["projects"]} />
      <ProjectsPage
        node="projects.by-phase"
        board="phase"
        params={routeParams}
        searchParams={await searchParams}
      />
    </>
  );
}
