import { getTranslations } from "next-intl/server";
import { ReadinessView } from "@/components/home/home-views";
import { PageHeader } from "@/components/projects/ui";
import { requireNode } from "@/components/shell/sitemap-page";
import { loadReadinessBoard } from "@/lib/home/data";
import { pickView } from "@/lib/home/views";
import { nodeHref } from "@/lib/shell/sitemap";

/** Home > Gate readiness across projects (Section 4.5.5). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/home/gate-readiness">) {
  const routeParams = await params;
  const ctx = await requireNode("home.gate-readiness", routeParams);
  const t = await getTranslations("home.readiness");
  const { readiness, totalGates } = await loadReadinessBoard(ctx);
  const { views, view } = pickView("home.gate-readiness", await searchParams);
  return (
    <>
      <PageHeader title={t("title")} />
      <ReadinessView
        org={ctx.org.slug}
        readiness={readiness}
        totalGates={totalGates}
        views={views}
        view={view}
        projectsHref={nodeHref("projects", routeParams) ?? ""}
      />
    </>
  );
}
