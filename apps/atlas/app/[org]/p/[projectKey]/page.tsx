import { notFound, redirect } from "next/navigation";
import { getProjectContextFor } from "@/lib/projects/context";
import { nodeHref } from "@/lib/shell/sitemap";

/** A project opens on its default landing tab, Overview (Section 4.5.4). */
export default async function ProjectPage({ params }: PageProps<"/[org]/p/[projectKey]">) {
  const routeParams = await params;
  if (!(await getProjectContextFor(routeParams))) notFound();
  const href = nodeHref("project.overview", routeParams);
  if (href === undefined) notFound();
  redirect(href);
}
