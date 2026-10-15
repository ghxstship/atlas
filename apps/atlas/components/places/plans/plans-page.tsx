import {
  listProjectOptions,
  listSitePlans,
  listVenues,
  listZones,
  type ArchiveFilter,
  type SitePlan,
} from "@xos/data/places";
import type { Route } from "next";
import Link from "next/link";
import { getFormatter } from "next-intl/server";
import { setPlaceArchivedAction } from "@/app/[org]/places/actions";
import { requireNode } from "@/components/shell/sitemap-page";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { heldCapabilities } from "../kit/access";
import { ActionButton } from "../kit/buttons";
import { QueryDrawer } from "../kit/client";
import { Collaboration } from "../kit/collaboration";
import {
  ArchiveFilter as ArchiveFilterLinks,
  BackLink,
  Collection,
  CollectionEmpty,
  CreateLink,
  EntityList,
  LinkFilter,
  RecordSection,
  SearchBox,
  type Search,
} from "../kit/parts";
import { Card, Gallery, InlineAlert, PropertyList, Tag, TemplateRecord } from "../kit/ui";
import { chooseView, matchesSearch, param, withQuery } from "../kit/views";
import { PlanCanvas, SitePlanForm } from "./plan-canvas";

const NODE = "places.site-plans";

/**
 * Site plans of the org's projects (Section 4.5.5 Places): gallery, site plan and list views. A site
 * plan belongs to a project and may name the venue it draws; pins mark zones and records on it.
 */
export async function PlansPage({
  params,
  search,
}: {
  params: Readonly<Record<string, string>>;
  search: Search;
}) {
  const ctx = await requireNode(NODE, params);
  const db = ctx.viewer.db;
  const archiveParam = param(search, "archive");
  const archive: ArchiveFilter =
    archiveParam === "archived" || archiveParam === "all" ? archiveParam : "live";
  const projectFilter = param(search, "project");
  const [plans, projects, venues, zones, t, held, format] = await Promise.all([
    listSitePlans(db, {
      orgId: ctx.org.id,
      archive: "all",
      ...(projectFilter ? { projectId: projectFilter } : {}),
    }),
    listProjectOptions(db, ctx.org.id),
    listVenues(db, ctx.org.id, "live"),
    listZones(db, { orgId: ctx.org.id }),
    getTranslate(),
    heldCapabilities(ctx),
    getFormatter(),
  ]);
  for (const r of [plans, projects, venues, zones]) {
    if (!r.ok) throw new Error(`Cannot load site plans: ${JSON.stringify(r.error)}`);
  }
  if (!plans.ok || !projects.ok || !venues.ok || !zones.ok) return null;
  const canWrite = held.has("places.site_plan.write");
  const path = nodeHref(NODE, params) ?? "/";
  const projectLabel = new Map(projects.data.map((p) => [p.id, `${p.key} ${p.name}`]));
  const venueName = new Map(venues.data.map((v) => [v.id, v.name]));
  const projectOptions = projects.data.map((p) => ({ id: p.id, label: `${p.key} ${p.name}` }));
  const venueOptions = venues.data.map((v) => ({ id: v.id, name: v.name }));
  const q = param(search, "q");
  // Archived rows are loaded too, so a peek can open an archived row to restore it.
  const inArchive = (archivedAt: string | null) =>
    archive === "all" || (archive === "archived") === (archivedAt !== null);
  const rows = plans.data.filter(
    (p) =>
      inArchive(p.archivedAt) &&
      matchesSearch(
        q,
        p.title,
        projectLabel.get(p.projectId) ?? null,
        p.venueId ? (venueName.get(p.venueId) ?? null) : null,
      ),
  );
  const zonesFor = (plan: SitePlan) =>
    zones.data.filter((z) => plan.venueId === null || z.venueId === plan.venueId);
  const peekId = param(search, "peek");
  const selected = peekId ? plans.data.find((p) => p.id === peekId) : undefined;

  const detail = (plan: SitePlan) => (
    <div className="flex flex-col gap-16">
      {plan.archivedAt ? (
        <InlineAlert tone="warning">{t("places.plans.archivedNotice")}</InlineAlert>
      ) : null}
      <PropertyList
        items={[
          {
            label: t("places.plans.fields.project"),
            value: projectLabel.get(plan.projectId) ?? "",
          },
          {
            label: t("places.plans.fields.venue"),
            value: plan.venueId
              ? (venueName.get(plan.venueId) ?? "")
              : t("places.plans.fields.noVenue"),
          },
          { label: t("places.plans.pins"), value: String(plan.pins.length) },
          {
            label: t("places.kit.updated"),
            value: format.dateTime(new Date(plan.updatedAt), { dateStyle: "medium" }),
          },
        ]}
      />
      <PlanCanvas
        org={ctx.org.slug}
        plan={plan}
        zones={zonesFor(plan)}
        canWrite={canWrite && !plan.archivedAt}
      />
      {canWrite ? (
        <RecordSection id="plan-edit" title={t("places.kit.edit")}>
          <SitePlanForm
            org={ctx.org.slug}
            plan={plan}
            projects={projectOptions}
            venues={venueOptions}
          />
          <ActionButton
            action={setPlaceArchivedAction}
            org={ctx.org.slug}
            fields={{
              table: "site_plans",
              id: plan.id,
              archived: plan.archivedAt ? "false" : "true",
            }}
            label={plan.archivedAt ? t("places.kit.restore") : t("places.kit.archive.action")}
            variant={plan.archivedAt ? "secondary" : "ghost"}
          />
        </RecordSection>
      ) : null}
      <Collaboration
        db={db}
        org={ctx.org.slug}
        subject={{ table: "app.site_plans", id: plan.id }}
        me={ctx.viewer.person?.id ?? null}
        canPost
      />
    </div>
  );

  if (peekId && param(search, "full") === "1") {
    return (
      <div className="flex flex-col gap-12">
        <BackLink
          href={withQuery(path, search, { peek: undefined, full: undefined })}
          label={t("places.plans.back")}
        />
        {selected ? (
          <TemplateRecord
            propertiesLabel={t("places.kit.properties")}
            header={
              <header className="flex flex-wrap items-center gap-8 border-b border-border-subtle pb-12">
                <h1 className="m-0 text-heading-24 font-semibold">{selected.title}</h1>
                <Tag>{projectLabel.get(selected.projectId) ?? ""}</Tag>
              </header>
            }
            properties={
              <PropertyList
                items={[
                  {
                    label: t("places.plans.fields.venue"),
                    value: selected.venueId
                      ? (venueName.get(selected.venueId) ?? "")
                      : t("places.plans.fields.noVenue"),
                  },
                  { label: t("places.plans.pins"), value: String(selected.pins.length) },
                ]}
              />
            }
          >
            {detail(selected)}
          </TemplateRecord>
        ) : (
          <InlineAlert tone="warning" title={t("places.kit.peekMissingTitle")}>
            {t("places.kit.peekMissing")}
          </InlineAlert>
        )}
      </div>
    );
  }

  const views = chooseView(NODE, param(search, "view"), {
    gallery: rows.length > 0,
    "site-plan": rows.length > 0,
  });
  let overlay = null;
  if (param(search, "create") === "1" && canWrite && projectOptions.length > 0) {
    overlay = (
      <QueryDrawer title={t("places.plans.create")} closeKeys={["create"]}>
        <SitePlanForm
          org={ctx.org.slug}
          projects={projectOptions}
          venues={venueOptions}
          {...(projectFilter ? { defaultProjectId: projectFilter } : {})}
        />
      </QueryDrawer>
    );
  } else if (peekId) {
    overlay = (
      <QueryDrawer title={t("places.plans.peekTitle")} closeKeys={["peek"]}>
        {selected ? (
          <div className="flex flex-col gap-16">
            <div className="flex flex-wrap items-center justify-between gap-8">
              <h3 className="m-0 text-heading-20 font-semibold">{selected.title}</h3>
              <Link
                href={withQuery(path, search, { full: "1" }) as Route}
                className="text-text-13 text-accent-text underline"
              >
                {t("places.kit.openFull")}
              </Link>
            </div>
            {detail(selected)}
          </div>
        ) : (
          <InlineAlert tone="warning" title={t("places.kit.peekMissingTitle")}>
            {t("places.kit.peekMissing")}
          </InlineAlert>
        )}
      </QueryDrawer>
    );
  }

  let body;
  if (projectOptions.length === 0) {
    body = (
      <CollectionEmpty
        icon="FolderKanban"
        sentence={t("places.plans.noProjects")}
        actionLabel={t("places.plans.openProjects")}
        href={nodeHref("projects", params) ?? "/"}
      />
    );
  } else if (plans.data.length === 0) {
    body = canWrite ? (
      <CollectionEmpty
        icon="Map"
        sentence={t("places.plans.empty")}
        actionLabel={t("places.plans.create")}
        href={withQuery(path, search, { create: "1" })}
      />
    ) : (
      <InlineAlert tone="info">{t("places.plans.emptyReadOnly")}</InlineAlert>
    );
  } else if (rows.length === 0) {
    body = <InlineAlert tone="info">{t("places.kit.noMatches")}</InlineAlert>;
  } else if (views.current === "site-plan") {
    const planId = param(search, "plan");
    const current = rows.find((p) => p.id === planId) ?? rows[0];
    body = current ? (
      <div className="flex flex-col gap-12">
        <LinkFilter
          path={path}
          search={search}
          label={t("places.plans.showing")}
          queryKey="plan"
          allLabel={current.title}
          options={rows.map((p) => ({ value: p.id, label: p.title }))}
        />
        <PlanCanvas
          org={ctx.org.slug}
          plan={current}
          zones={zonesFor(current)}
          canWrite={canWrite && !current.archivedAt}
        />
      </div>
    ) : null;
  } else if (views.current === "gallery") {
    body = (
      <Gallery label={t("places.plans.title")}>
        {rows.map((p) => (
          <Link
            key={p.id}
            href={withQuery(path, search, { peek: p.id }) as Route}
            scroll={false}
            className="block no-underline"
          >
            <Card
              title={p.title}
              meta={t("places.plans.pinCount", { count: p.pins.length })}
              interactive
            >
              <div className="flex flex-col gap-4 text-text-13 text-text-secondary">
                <span>{projectLabel.get(p.projectId)}</span>
                <span>
                  {p.venueId ? venueName.get(p.venueId) : t("places.plans.fields.noVenue")}
                </span>
              </div>
            </Card>
          </Link>
        ))}
      </Gallery>
    );
  } else {
    body = (
      <EntityList
        label={t("places.plans.title")}
        path={path}
        search={search}
        rows={rows.map((p) => ({
          id: p.id,
          title: p.title,
          meta: [projectLabel.get(p.projectId), p.venueId ? venueName.get(p.venueId) : null]
            .filter(Boolean)
            .join(" · "),
          chips: (
            <>
              <Tag>{t("places.plans.pinCount", { count: p.pins.length })}</Tag>
              {p.archivedAt ? <Tag tone="warning">{t("places.kit.archived")}</Tag> : null}
            </>
          ),
        }))}
      />
    );
  }

  return (
    <Collection
      title={t("places.plans.title")}
      count={rows.length}
      views={views}
      primary={
        canWrite && projectOptions.length > 0 ? (
          <CreateLink path={path} search={search} label={t("places.plans.create")} />
        ) : null
      }
      filters={
        <>
          <SearchBox path={path} search={search} label={t("places.plans.search")} />
          <LinkFilter
            path={path}
            search={search}
            label={t("places.plans.fields.project")}
            queryKey="project"
            allLabel={t("places.plans.allProjects")}
            options={projectOptions.map((p) => ({ value: p.id, label: p.label }))}
          />
          <ArchiveFilterLinks path={path} search={search} current={archive} t={t} />
        </>
      }
      overlay={overlay}
    >
      {body}
    </Collection>
  );
}
