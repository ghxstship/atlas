import { ProjectsPage } from "@/components/projects/projects-page";

/** Projects > Portfolio timeline (Section 4.5.5): project dates side by side, or by month. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/projects/portfolio-timeline">) {
  return (
    <ProjectsPage
      node="projects.portfolio-timeline"
      params={await params}
      searchParams={await searchParams}
    />
  );
}
