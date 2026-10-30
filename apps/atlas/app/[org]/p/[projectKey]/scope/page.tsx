import {
  countRecordsByCoordinate,
  listDepartments,
  listPhases,
  listScopeNodes,
  listVenues,
} from "@xos/data/projects";
import { departmentsInUse, getDepartmentsInUse } from "@xos/data/org-setup";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ReconciliationPanel } from "@/components/places/reconciliation/reconciliation-panel";
import { ScopeView } from "@/components/projects/scope-view";
import { PageHeader } from "@/components/projects/ui";
import { requireNode } from "@/lib/shell/require-node";
import { getProjectContextFor } from "@/lib/projects/context";
import { must } from "@/lib/projects/loaders";
import { CollectionPage } from "@/components/platform/collection-page";

const VIEWS = ["tree", "list", "matrix"] as const;

/** Project Scope (Section 4.5.4): the scope tree, its list and the project's coordinate matrix. */
export default async function ScopePage({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/scope">) {
  const routeParams = await params;
  await requireNode("project.scope", routeParams);
  const ctx = await getProjectContextFor(routeParams);
  if (!ctx) notFound();
  const search = await searchParams;
  const db = ctx.org.viewer.db;
  const t = await getTranslations("projects");
  const view = VIEWS.find((v) => v === search["view"]) ?? "tree";
  const [nodes, venues, departments, phases, cells, inUse] = await Promise.all([
    listScopeNodes(db, ctx.project.id),
    listVenues(db, ctx.org.org.id),
    view === "matrix" ? listDepartments(db) : Promise.resolve({ ok: true as const, data: [] }),
    listPhases(db),
    view === "matrix"
      ? countRecordsByCoordinate(db, ctx.project.id)
      : Promise.resolve({ ok: true as const, data: {} }),
    view === "matrix"
      ? getDepartmentsInUse(db, ctx.org.org.id)
      : Promise.resolve({ ok: true as const, data: { departments: [], disciplines: [] } }),
  ]);
  const counts = must(cells, "coordinate matrix");
  // The matrix shows the departments the org works in (1430), and any other department that holds records, so
  // nothing the project already has disappears.
  const withRecords = Object.entries(counts)
    .filter(([, n]) => Number(n) > 0)
    .map(([key]) => key.split("|")[0] ?? "");
  return (
    <CollectionPage header={<PageHeader title={t("scope.title")} />}>
      <ScopeView
        org={ctx.org.org.slug}
        projectKey={ctx.project.key}
        nodes={must(nodes, "scope tree")}
        venues={must(venues, "venues").map((v) => ({ value: v.id, label: v.name }))}
        canWrite={ctx.capabilities.has("projects.scope.write")}
        views={VIEWS}
        view={view}
        departments={departmentsInUse(
          must(departments, "departments"),
          inUse.ok ? inUse.data.departments : [],
          withRecords,
        )}
        phases={must(phases, "phases").map((p) => ({ code: p.code, gate: p.gate }))}
        cells={counts}
      />
      <ReconciliationPanel ctx={ctx.org} projectId={ctx.project.id} />
    </CollectionPage>
  );
}
