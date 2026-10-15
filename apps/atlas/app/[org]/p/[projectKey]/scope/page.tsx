import {
  countRecordsByCoordinate,
  listDepartments,
  listPhases,
  listScopeNodes,
  listVenues,
} from "@xos/data/projects";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ScopeView } from "@/components/projects/scope-view";
import { PageHeader } from "@/components/projects/ui";
import { requireNode } from "@/components/shell/sitemap-page";
import { getProjectContextFor } from "@/lib/projects/context";
import { must } from "@/lib/projects/loaders";

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
  const [nodes, venues, departments, phases, cells] = await Promise.all([
    listScopeNodes(db, ctx.project.id),
    listVenues(db, ctx.org.org.id),
    view === "matrix" ? listDepartments(db) : Promise.resolve({ ok: true as const, data: [] }),
    listPhases(db),
    view === "matrix"
      ? countRecordsByCoordinate(db, ctx.project.id)
      : Promise.resolve({ ok: true as const, data: {} }),
  ]);
  return (
    <>
      <PageHeader title={t("scope.title")} />
      <ScopeView
        org={ctx.org.org.slug}
        projectKey={ctx.project.key}
        nodes={must(nodes, "scope tree")}
        venues={must(venues, "venues").map((v) => ({ value: v.id, label: v.name }))}
        canWrite={ctx.capabilities.has("projects.scope.write")}
        views={VIEWS}
        view={view}
        departments={must(departments, "departments")}
        phases={must(phases, "phases").map((p) => ({ code: p.code, gate: p.gate }))}
        cells={must(cells, "coordinate matrix")}
      />
    </>
  );
}
