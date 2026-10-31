import {
  MEASUREMENT_CRITERION,
  OBJECTIVES_CRITERION,
  measurementEvidenceUri,
} from "@xos/data/measurements";
import { listAssertionRanks, listSetupProgress } from "@xos/data/projects";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { GatesView } from "@/components/projects/gates-view";
import { PageHeader, TemplateCollection } from "@/components/projects/ui";
import {
  MeasurementPanel,
  ObjectivesPanel,
  attestedOn,
  loadMeasurementData,
} from "@/components/measurement/gate-panels";
import { requireNode } from "@/lib/shell/require-node";
import { getProjectContextFor } from "@/lib/projects/context";
import { loadGates, must } from "@/lib/projects/loaders";

/**
 * Project Gates (Section 4.5.4): list or board of the nine gates, criteria and evidence. Gate 1 carries the
 * project's objectives and gate 8 the measurement against them (A98, Section 4.10).
 */
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
  const view = search["view"] === "board" ? "board" : "list";
  const [gates, ranks, measurement, setup] = await Promise.all([
    loadGates(ctx),
    listAssertionRanks(ctx.org.viewer.db),
    view === "list" ? loadMeasurementData(ctx) : Promise.resolve(null),
    listSetupProgress(ctx.org.viewer.db, ctx.project.id),
  ]);
  const canAttest = ctx.capabilities.has("projects.gate.evidence.write");
  const canPass =
    ctx.capabilities.has("projects.gate.transition") && ctx.project.projectState !== "Canceled";
  const passed = new Set(gates.transitions.map((x) => x.gate));
  // The board view shows criteria only; the panels belong to the list.
  const gatePanels = measurement
    ? {
        1: (
          <ObjectivesPanel
            ctx={ctx}
            data={measurement}
            gatePassed={passed.has(1)}
            canEdit={canAttest && (!passed.has(1) || canPass)}
            canAttest={canAttest}
            attested={attestedOn(
              gates.evidence,
              OBJECTIVES_CRITERION,
              measurementEvidenceUri("objectives", ctx.project.id),
            )}
          />
        ),
        8: (
          <MeasurementPanel
            ctx={ctx}
            data={measurement}
            canWrite={canAttest}
            canAttest={canAttest && !passed.has(8)}
            attested={attestedOn(
              gates.evidence,
              MEASUREMENT_CRITERION,
              measurementEvidenceUri("measurement", ctx.project.id),
            )}
          />
        ),
      }
    : undefined;
  return (
    <TemplateCollection header={<PageHeader title={t("gates.title")} />}>
      <GatesView
        org={ctx.org.org.slug}
        projectKey={ctx.project.key}
        phases={gates.phases}
        criteria={gates.criteria}
        evidence={gates.evidence}
        transitions={gates.transitions}
        ranks={must(ranks, "assertion ranks")}
        currentGate={gates.currentGate}
        canAttest={canAttest}
        canPass={canPass}
        views={["list", "board"]}
        view={view}
        setup={setup.ok ? setup.data : []}
        {...(gatePanels ? { gatePanels } : {})}
      />
    </TemplateCollection>
  );
}
