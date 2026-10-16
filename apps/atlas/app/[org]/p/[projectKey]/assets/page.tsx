import { UnitsView } from "@/components/assets/units-view";
import { requireProjectTab } from "@/lib/assets/guard";
import { readQuery } from "@/lib/assets/views";

/**
 * Project tab Assets (Section 4.5.4): the units out for this project, their custody and damage,
 * through the same component as Assets > Units with the project filter.
 */
export default async function ProjectAssetsPage({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/assets">) {
  const p = await params;
  const { ctx, project } = await requireProjectTab("project.assets", p);
  return (
    <UnitsView
      ctx={ctx}
      node="project.assets"
      query={readQuery(await searchParams)}
      basePath={`/${ctx.org.slug}/p/${project.key}/assets`}
      project={project}
    />
  );
}
