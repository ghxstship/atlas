import { listMembers } from "@xos/data";
import { listSharedWithMe } from "@xos/data/access-controls";
import { getNode } from "@xos/ia";
import {
  listCurrencies,
  listJurisdictions,
  listMovableStates,
  listPhases,
  listProjects,
  listRegions,
  listTiers,
  listVenues,
  type ProjectSummary,
} from "@xos/data/projects";
import { getTranslations } from "next-intl/server";
import type { BulkConfig, BulkField } from "@/components/bulk/types";
import { PROJECT_STATE_ORDER } from "@/lib/projects/format";
import { requireNode } from "@/lib/shell/require-node";
import { sitemap } from "@/lib/shell/sitemap";
import { orgToday } from "@/lib/shell/time-zone";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import type { OrgContext } from "@/lib/shell/context";
import { LoadError } from "./load-error";
import { CustomFieldList } from "@/components/custom-fields/list";
import { customFieldList } from "@/lib/custom-fields/server";
import { ProjectCollection, type BoardMode, type ProjectView } from "./project-collection";
import { SharedWithUs } from "./shared-with-us";
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

/** Up to three people who can add the reader to a project: the org's Owners, Admins and Producers. */
async function projectSharers(ctx: OrgContext): Promise<string[]> {
  const members = await listMembers(ctx.viewer.db, ctx.org.id);
  if (!members.ok) return [];
  return members.data
    .filter((m) => m.roles.some((r) => ["owner", "admin", "manager"].includes(r.code)))
    .flatMap((m) => (m.fullName ? [m.fullName] : []))
    .slice(0, 3);
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
 * Bulk edit of projects (Section 11.7): state, venue and archiving across a selection, each offered
 * to people who hold its capability (the database checks it again on every row). A project in a
 * state it cannot leave (Canceled) offers no state change. Null when none is offered.
 */
async function projectBulkConfig(
  ctx: OrgContext,
  projects: readonly ProjectSummary[],
  t: Translate,
): Promise<BulkConfig | null> {
  const caps = ctx.capabilities;
  const db = ctx.viewer.db;
  const [movable, venues] = await Promise.all([
    caps.has("projects.settings.write") ? listMovableStates(db, "project") : null,
    caps.has("projects.project.write") ? listVenues(db, ctx.org.id) : null,
  ]);
  const fields: BulkField[] = [];
  if (movable?.ok) {
    const from = new Set(movable.data);
    fields.push({
      key: "project_state",
      label: t("projects.fields.state"),
      reason: true,
      options: PROJECT_STATE_ORDER.map((s) => ({ value: s, label: t(`projects.states.${s}`) })),
      rows: projects.filter((p) => from.has(p.projectState)).map((p) => p.id),
    });
  }
  if (venues?.ok) {
    fields.push({
      key: "venue_id",
      label: t("projects.fields.venue"),
      options: [
        { value: null, label: t("projects.values.none") },
        ...venues.data.map((v) => ({ value: v.id, label: v.name })),
      ],
    });
  }
  if (caps.has("projects.project.archive")) {
    // true archives now; null restores (migration 2130).
    fields.push({
      key: "archived_at",
      label: t("projects.fields.archiveStatus"),
      options: [
        { value: true, label: t("projects.values.archived") },
        { value: null, label: t("projects.values.notArchived") },
      ],
    });
  }
  return fields.length > 0 ? { org: ctx.org.slug, resource: "projects", fields } : null;
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
  // The portfolio is the org's: today and this month on its calendar, not UTC's (A71).
  const today = await orgToday(ctx);
  const monthParam = one(searchParams, "month");
  const month =
    monthParam && /^\d{4}-\d{2}-01$/.test(monthParam) ? monthParam : `${today.slice(0, 7)}-01`;

  const db = ctx.viewer.db;
  const [projects, phases, shared, custom] = await Promise.all([
    listProjects(db, ctx.org.id, { includeArchived }),
    listPhases(db),
    // Projects partner orgs share with this org (A52, Section 8.5), on the main list only.
    node === "projects" ? listSharedWithMe(db) : Promise.resolve({ ok: true as const, data: [] }),
    customFieldList(ctx, "app.projects", searchParams),
  ]);
  if (!projects.ok || !phases.ok) return <LoadError title={translate(entry.label)} />;
  const canCreate = ctx.capabilities.has("projects.project.create");
  // A reader who cannot create a project and has none shared learns who can share one (A59-014).
  const sharers = !canCreate && projects.data.length === 0 ? await projectSharers(ctx) : [];
  const listed = projects.data.filter((p) => custom.keep(p.id));

  return (
    <CustomFieldList value={await custom.view(listed.map((p) => p.id))}>
      <ProjectCollection
        org={ctx.org.slug}
        title={translate(entry.label)}
        projects={listed}
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
        sharers={sharers}
        bulk={view === "table" ? await projectBulkConfig(ctx, projects.data, translate) : null}
      />
      <SharedWithUs shared={shared.ok ? shared.data : []} />
    </CustomFieldList>
  );
}
