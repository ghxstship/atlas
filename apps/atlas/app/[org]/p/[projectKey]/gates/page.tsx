import { listAssertionRanks } from "@xos/data/projects";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { GatesView } from "@/components/projects/gates-view";
import { PageHeader } from "@/components/projects/ui";
import { requireNode } from "@/lib/shell/require-node";
import { getProjectContextFor } from "@/lib/projects/context";
import { loadGates, must } from "@/lib/projects/loaders";

/** Project Gates (Section 4.5.4): list or board of the nine gates, criteria and evidence. */
export default async function GatesPage({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/gates">) {
  const routeParams = await params;
  await requireNode("project.gates", routeParams);
  const ctx = await getProjectContextFor(routeParams);
  if (!ctx) notFound();
  const search = await searchParams;
  const t = await getTranslations("projects");
  const [gates, ranks] = await Promise.all([loadGates(ctx), listAssertionRanks(ctx.org.viewer.db)]);
  const view = search["view"] === "board" ? "board" : "list";
  return (
    <>
      <PageHeader title={t("gates.title")} />
      <GatesView
        org={ctx.org.org.slug}
        projectKey={ctx.project.key}
        phases={gates.phases}
        criteria={gates.criteria}
        evidence={gates.evidence}
        transitions={gates.transitions}
        ranks={must(ranks, "assertion ranks")}
        currentGate={gates.currentGate}
        canAttest={ctx.capabilities.has("projects.gate.evidence.write")}
        canPass={
          ctx.capabilities.has("projects.gate.transition") &&
          ctx.project.projectState !== "Canceled"
        }
        views={["list", "board"]}
        view={view}
      />
    </>
  );
}
