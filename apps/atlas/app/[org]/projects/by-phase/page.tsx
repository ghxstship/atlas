import { ProjectsPage } from "@/components/projects/projects-page";

/** Projects > By phase (Section 4.5.5): the board by gate, one column per gated phase. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/projects/by-phase">) {
  return (
    <ProjectsPage
      node="projects.by-phase"
      board="phase"
      params={await params}
      searchParams={await searchParams}
    />
  );
}
