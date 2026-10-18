import { notFound } from "next/navigation";
import { SafetyTiles } from "@/components/safety/landing/safety-landing";
import { PermitsView } from "@/components/safety/permits/permits-page";
import { requireNode } from "@/lib/shell/require-node";
import { getProjectContextFor } from "@/lib/projects/context";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Project Safety (Section 4.5.4, A09): the permit engine for this project, with canon lead times
 * (journey 1), and the project's way into inspections, incidents, emergency codes and the radio plan.
 */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/safety">) {
  const routeParams = await params;
  await requireNode("project.safety", routeParams);
  const ctx = await getProjectContextFor(routeParams);
  if (!ctx) notFound();
  const t = await getTranslate();
  const path = nodeHref("project.safety", routeParams) ?? "/";
  const settings = nodeHref("project.settings", routeParams);
  return (
    <div className="flex flex-col gap-24">
      <PermitsView
        ctx={ctx.org}
        path={path}
        search={await searchParams}
        projectId={ctx.project.id}
        showProjectFilter={false}
        {...(settings ? { projectSettingsHref: settings } : {})}
      />
      <section aria-labelledby="project-safety-more" className="flex flex-col gap-12">
        <h2 id="project-safety-more" className="m-0 text-heading-16 font-semibold">
          {t("permits.landing.projectMore")}
        </h2>
        <SafetyTiles
          ctx={ctx.org}
          t={t}
          projectId={ctx.project.id}
          heading={t("permits.landing.projectMore")}
        />
      </section>
    </div>
  );
}
