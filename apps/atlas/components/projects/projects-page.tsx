import { getNode } from "@xos/ia";
import {
  listCurrencies,
  listJurisdictions,
  listPhases,
  listProjects,
  listRegions,
  listTiers,
  listVenues,
} from "@xos/data/projects";
import { getTranslations } from "next-intl/server";
import { requireNode } from "@/lib/shell/require-node";
import { sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import type { OrgContext } from "@/lib/shell/context";
import { LoadError } from "./load-error";
import { ProjectCollection, type BoardMode, type ProjectView } from "./project-collection";
import type { ProjectFormOptions } from "./create-project";

type Search = Readonly<Record<string, string | string[] | undefined>>;

const PROJECT_VIEWS: readonly ProjectView[] = [
  "table",
  "list",
  "board",
  "gallery",
  "timeline",
  "calendar",
];

function one(search: Search, name: string): string | undefined {
  const v = search[name];
  return Array.isArray(v) ? v[0] : v;
}

/** The New project form's lists: canon jurisdictions, tiers and regions, and the org's venues. */
export async function projectFormOptions(ctx: OrgContext): Promise<ProjectFormOptions> {
  const db = ctx.viewer.db;
  const t = await getTranslations("projects");
  const [jurisdictions, tiers, regions, venues, currencies] = await Promise.all([
    listJurisdictions(db),
    listTiers(db),
    listRegions(db),
    listVenues(db, ctx.org.id),
    listCurrencies(db),
  ]);
  for (const r of [jurisdictions, tiers, regions, venues, currencies]) {
    if (!r.ok) throw new Error(`Cannot read project form lists: ${JSON.stringify(r.error)}`);
  }
  return {
    jurisdictions: jurisdictions.ok
      ? jurisdictions.data.map((j) => ({
          value: j.id,
          label: j.populated ? j.id : t("values.unpopulated", { id: j.id }),
        }))
      : [],
    tiers: tiers.ok
      ? tiers.data.map((x) => ({ value: x.code, label: `${x.code} ${x.label}` }))
      : [],
    regions: regions.ok ? regions.data.map((x) => ({ value: x.code, label: x.label })) : [],
    venues: venues.ok ? venues.data.map((v) => ({ value: v.id, label: v.name })) : [],
    timeZones: Intl.supportedValuesOf("timeZone"),
    currencies: currencies.ok ? currencies.data : [],
    defaultTimeZone: "America/New_York",
  };
}

/**
 * A Projects page (Section 4.5.5): All projects, By phase and Portfolio timeline share this server
 * half, which reads the projects the viewer may see and offers the views the sitemap lists for the
 * node. Creating is offered only to holders of projects.project.create.
 */
export async function ProjectsPage({
  node,
  params,
  searchParams,
  board = "state",
}: {
  node: string;
  params: Readonly<Record<string, string>>;
  searchParams: Search;
  board?: BoardMode;
}) {
  const ctx = await requireNode(node, params);
  const translate = await getTranslate();
  const entry = getNode(sitemap, node).node;
  const list = entry.list;
  const views = (list?.views ?? ["table"]).filter((v): v is ProjectView =>
    (PROJECT_VIEWS as readonly string[]).includes(v),
  );
  const requested = one(searchParams, "view");
  const fallback = (list?.default ?? views[0] ?? "table") as ProjectView;
  const view = views.find((v) => v === requested) ?? fallback;
  const includeArchived = one(searchParams, "archived") === "1";
  const today = new Date().toISOString().slice(0, 10);
  const monthParam = one(searchParams, "month");
  const month =
    monthParam && /^\d{4}-\d{2}-01$/.test(monthParam) ? monthParam : `${today.slice(0, 7)}-01`;

  const db = ctx.viewer.db;
  const [projects, phases] = await Promise.all([
    listProjects(db, ctx.org.id, { includeArchived }),
    listPhases(db),
  ]);
  if (!projects.ok || !phases.ok) return <LoadError title={translate(entry.label)} />;
  const canCreate = ctx.capabilities.has("projects.project.create");

  return (
    <ProjectCollection
      org={ctx.org.slug}
      title={translate(entry.label)}
      projects={projects.data}
      phases={phases.data.map((p) => ({ code: p.code, gate: p.gate }))}
      views={views}
      view={view}
      board={board}
      includeArchived={includeArchived}
      month={month}
      today={today}
      create={
        canCreate
          ? { options: await projectFormOptions(ctx), open: one(searchParams, "create") === "1" }
          : null
      }
    />
  );
}
