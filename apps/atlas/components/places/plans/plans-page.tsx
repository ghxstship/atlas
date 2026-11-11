import { listThreads } from "@xos/data/comments";
import {
  compareLevels,
  isLegacyPlan,
  listProjectOptions,
  listSitePlans,
  listSitePlanShapes,
  listVenueLevels,
  listVenues,
  listZones,
  SITE_PLAN_STATES,
  sortPlansByLevel,
  type SitePlan,
  type SitePlanShape,
  type SitePlanState,
} from "@xos/data/places";
import { listProjectMembers } from "@xos/data/projects";
import { listPeopleNames } from "@xos/data/safety-permits";
import { listSigns } from "@xos/data/signage";
import type { Route } from "next";
import dynamic from "next/dynamic";
import Link from "next/link";
import { getFormatter, getLocale } from "next-intl/server";
import { setPlaceArchivedAction } from "@/app/[org]/places/actions";
import { documentHref } from "@/lib/documents/links";
import { getShellSettings } from "@/lib/shell/org-settings";
import { requireNode } from "@/lib/shell/require-node";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { unitSystemFor } from "@/lib/workforce/units";
import { heldCapabilities } from "../kit/access";
import { ActionButton } from "../kit/buttons";
import { QueryDrawer } from "../kit/client";
import { Collaboration } from "../kit/collaboration";
import {
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
import { Card, InlineAlert, PropertyList, Tag, TemplateRecord } from "../kit/ui";
import { Gallery } from "@/components/platform/client/gallery";
import { chooseView, matchesSearch, param, withQuery } from "../kit/views";
import { PlanCanvas, SitePlanForm, type PointNote } from "./plan-canvas";
import { PlanStateActions } from "./plan-state-actions";
import { formatLength } from "./plan-units";
import { PlanThread, type PlanThreadSubject } from "./plan-threads";

const NODE = "places.site-plans";

/** The drawing upload and the export panel load on demand, never with the page (ADR 0140). */
const DrawingUpload = dynamic(() => import("./drawing-upload").then((m) => m.DrawingUpload));
const PlanExportPanel = dynamic(() => import("./plan-export-panel").then((m) => m.PlanExportPanel));

/** The states the list shows by default: everything but Archived (ADR 0140 D1). */
const OPEN_STATES: readonly SitePlanState[] = ["Draft", "Locked", "Live"];

const STATE_TONE: Readonly<Record<SitePlanState, "neutral" | "accent" | "success" | "warning">> = {
  Draft: "neutral",
  Locked: "accent",
  Live: "success",
  Archived: "warning",
};

/** The same page with the thread of a pin, a shape or a point note open. */
function threadLink(
  href: string,
  query: Search,
  plan: SitePlan,
  target: { pin?: string; shape?: string; note?: string },
): string {
  return withQuery(href, query, {
    peek: plan.id,
    pin: target.pin,
    shape: target.shape,
    note: target.note,
  });
}

/**
 * Site plans of the org's projects (Section 4.5.5 Places; B1, ADR 0140): list, gallery and site plan views of plans in
 * Draft, Locked or Live (Archived on request), ordered by level, then title. A plan belongs to a project, may name the
 * venue and level it draws, and carries pins and shapes on its stored drawing. Moving a plan to Trash is deleting it.
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
  const projectFilter = param(search, "project");
  const stateParam = param(search, "state");
  const states: readonly SitePlanState[] =
    stateParam === "all"
      ? SITE_PLAN_STATES
      : SITE_PLAN_STATES.includes(stateParam as SitePlanState)
        ? [stateParam as SitePlanState]
        : OPEN_STATES;
  const levelFilter = param(search, "level");
  const [plans, projects, venues, zones, levels, t, held, format, shell, locale] =
    await Promise.all([
      listSitePlans(db, {
        orgId: ctx.org.id,
        archive: "all",
        ...(projectFilter ? { projectId: projectFilter } : {}),
      }),
      listProjectOptions(db, ctx.org.id),
      listVenues(db, ctx.org.id, "live"),
      listZones(db, { orgId: ctx.org.id }),
      listVenueLevels(db, { orgId: ctx.org.id }),
      getTranslate(),
      heldCapabilities(ctx),
      getFormatter(),
      getShellSettings(db, ctx.org.id, null),
      getLocale(),
    ]);
  for (const r of [plans, projects, venues, zones, levels]) {
    if (!r.ok) throw new Error(`Cannot load site plans: ${JSON.stringify(r.error)}`);
  }
  if (!plans.ok || !projects.ok || !venues.ok || !zones.ok || !levels.ok) return null;
  const units = unitSystemFor(shell.preferences.units, null, locale);
  const canWrite = held.has("places.site_plan.write");
  const path = nodeHref(NODE, params) ?? "/";
  const projectLabel = new Map(projects.data.map((p) => [p.id, `${p.key} ${p.name}`]));
  const venueName = new Map(venues.data.map((v) => [v.id, v.name]));
  const level = new Map(levels.data.map((l) => [l.id, l]));
  const projectOptions = projects.data.map((p) => ({ id: p.id, label: `${p.key} ${p.name}` }));
  const venueOptions = venues.data.map((v) => ({ id: v.id, name: v.name }));
  const levelOptions = levels.data.map((l) => ({ id: l.id, venueId: l.venueId, name: l.name }));
  const q = param(search, "q");
  const live = plans.data.filter((p) => p.archivedAt === null);
  const shapes = await listSitePlanShapes(
    db,
    live.map((p) => p.id),
  );
  if (!shapes.ok) throw new Error(`Cannot load site plan shapes: ${JSON.stringify(shapes.error)}`);
  const shapesOf = (plan: SitePlan) => shapes.data.filter((s) => s.sitePlanId === plan.id);
  const rows = sortPlansByLevel(
    live.filter(
      (p) =>
        states.includes(p.planState) &&
        (!levelFilter || p.venueLevelId === levelFilter) &&
        matchesSearch(
          q,
          p.title,
          projectLabel.get(p.projectId) ?? null,
          p.venueId ? (venueName.get(p.venueId) ?? null) : null,
        ),
    ),
    levels.data,
  );
  const zonesFor = (plan: SitePlan) =>
    zones.data.filter((z) => plan.venueId === null || z.venueId === plan.venueId);
  const levelName = (plan: SitePlan) =>
    plan.venueLevelId
      ? (level.get(plan.venueLevelId)?.name ?? "")
      : t("places.plans.levels.noLevel");
  const pinParam = param(search, "pin");
  const shapeParam = param(search, "shape");
  const peekId =
    param(search, "peek") ??
    (pinParam
      ? plans.data.find((p) => p.pins.some((pin) => pin.id === pinParam))?.id
      : undefined) ??
    (shapeParam ? shapes.data.find((s) => s.id === shapeParam)?.sitePlanId : undefined);
  const selected = peekId ? plans.data.find((p) => p.id === peekId) : undefined;

  const stateChip = (plan: SitePlan) => (
    <Tag tone={STATE_TONE[plan.planState]}>{t(`places.plans.states.${plan.planState}`)}</Tag>
  );

  /** The interactive canvas of a plan, with its notes, signs, people and open comment counts. */
  const canvas = async (plan: SitePlan, href: string, query: Search) => {
    const [threads, signs, pinThreads] = await Promise.all([
      listThreads(db, { table: "app.site_plans", id: plan.id }),
      listSigns(db, { orgId: ctx.org.id, projectId: plan.projectId }),
      db
        .from("comment_threads")
        .select("subject_id, resolved_at, comments(id, deleted_at)")
        .in("subject_table", ["app.site_plan_pins", "app.site_plan_shapes"])
        .in("subject_id", [...plan.pins.map((p) => p.id), ...shapesOf(plan).map((s) => s.id)])
        .is("deleted_at", null),
    ]);
    const notes: PointNote[] = (threads.ok ? threads.data : [])
      .filter((th) => th.anchor?.startsWith("point:"))
      .map((th) => ({
        threadId: th.id,
        anchor: th.anchor as string,
        resolved: th.resolvedAt !== null,
        count: th.comments.filter((c) => c.deletedAt === null).length,
      }));
    const signsAtPins: Record<string, string[]> = {};
    for (const s of signs.ok ? signs.data : []) {
      if (s.sitePlanPinId) (signsAtPins[s.sitePlanPinId] ??= []).push(`${s.key} ${s.title}`);
    }
    const openComments: Record<string, number> = {};
    for (const row of (pinThreads.data ?? []) as {
      subject_id: string;
      resolved_at: string | null;
      comments: { id: string; deleted_at: string | null }[];
    }[]) {
      if (row.resolved_at !== null) continue;
      openComments[row.subject_id] =
        (openComments[row.subject_id] ?? 0) +
        row.comments.filter((c) => c.deleted_at === null).length;
    }
    const showResolved = param(query, "resolved") === "1";
    return (
      <PlanCanvas
        org={ctx.org.slug}
        plan={plan}
        shapes={shapesOf(plan)}
        zones={zonesFor(plan)}
        canWrite={canWrite && plan.archivedAt === null}
        canComment={plan.archivedAt === null}
        notes={notes}
        units={units}
        signsAtPins={signsAtPins}
        openComments={openComments}
        showResolved={showResolved}
        resolvedHref={withQuery(href, query, { resolved: showResolved ? undefined : "1" })}
        threadHrefs={Object.fromEntries([
          ...plan.pins.map((pin) => [pin.id, threadLink(href, query, plan, { pin: pin.id })]),
          ...shapesOf(plan).map((s) => [s.id, threadLink(href, query, plan, { shape: s.id })]),
          ...notes.map((n) => [n.threadId, threadLink(href, query, plan, { note: n.threadId })]),
        ])}
      />
    );
  };

  /** The open thread of a pin, a shape or a point note, from the query. */
  const thread = async (plan: SitePlan) => {
    const noteParam = param(search, "note");
    const pin = pinParam ? plan.pins.find((p) => p.id === pinParam) : undefined;
    const shape: SitePlanShape | undefined = shapeParam
      ? shapesOf(plan).find((s) => s.id === shapeParam)
      : undefined;
    let subject: PlanThreadSubject | null = null;
    let title = "";
    if (pin) {
      subject = { table: "app.site_plan_pins", id: pin.id, anchor: null };
      title = t("places.plans.notes.pinTitle", { label: pin.label });
    } else if (shape) {
      subject = { table: "app.site_plan_shapes", id: shape.id, anchor: null };
      title = t("places.plans.notes.shapeTitle", { label: shape.label });
    }
    const threads = await listThreads(
      db,
      subject ? { table: subject.table, id: subject.id } : { table: "app.site_plans", id: plan.id },
    );
    if (!threads.ok) return null;
    const found = subject
      ? (threads.data.find((th) => th.anchor === null) ?? null)
      : (threads.data.find((th) => th.id === noteParam) ?? null);
    if (!subject) {
      if (!found?.anchor) return null;
      subject = { table: "app.site_plans", id: plan.id, anchor: found.anchor };
      title = t("places.plans.notes.noteTitle");
    }
    const [members, names] = await Promise.all([
      listProjectMembers(db, plan.projectId),
      listPeopleNames(db, [
        ...(found?.comments ?? []).flatMap((c) => [c.authorPersonId, ...c.mentionedPersonIds]),
      ]),
    ]);
    const people = (members.ok ? members.data : [])
      .filter((m) => m.personId && m.personId !== ctx.viewer.person?.id)
      .map((m) => ({ id: m.personId as string, name: m.fullName ?? "" }));
    return (
      <PlanThread
        org={ctx.org.slug}
        title={title}
        subject={subject}
        thread={found}
        names={{
          ...Object.fromEntries(names.ok ? names.data : []),
          ...Object.fromEntries(people.map((p) => [p.id, p.name])),
        }}
        people={people}
        canPost={plan.archivedAt === null}
      />
    );
  };

  const detail = async (plan: SitePlan) => {
    const trashed = plan.archivedAt !== null;
    const draft = plan.planState === "Draft";
    return (
      <div className="flex flex-col gap-16">
        {trashed ? <InlineAlert tone="warning">{t("places.plans.trashNotice")}</InlineAlert> : null}
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
            { label: t("places.plans.levels.level"), value: levelName(plan) },
            { label: t("places.plans.state"), value: t(`places.plans.states.${plan.planState}`) },
            { label: t("places.plans.pins"), value: String(plan.pins.length) },
            { label: t("places.plans.shapes"), value: String(shapesOf(plan).length) },
            {
              label: t("places.plans.scale"),
              value: plan.calibration
                ? t("places.plans.scaleValue", {
                    distance: formatLength(plan.calibration.feet, units, locale),
                  })
                : t("places.plans.notCalibrated"),
            },
            {
              label: t("places.kit.updated"),
              value: format.dateTime(new Date(plan.updatedAt), { dateStyle: "medium" }),
            },
          ]}
        />
        {canWrite && !trashed ? (
          <PlanStateActions org={ctx.org.slug} id={plan.id} state={plan.planState} />
        ) : null}
        {await canvas(plan, path, search)}
        {await thread(plan)}
        {canWrite &&
        !trashed &&
        draft &&
        (plan.awaitingDrawing || isLegacyPlan(plan) || plan.drawing !== null) ? (
          <DrawingUpload
            org={ctx.org.slug}
            sitePlanId={plan.id}
            hasPins={plan.drawing === null && plan.pins.length > 0}
          />
        ) : null}
        {!trashed ? (
          <PlanExportPanel href={documentHref(ctx.org.slug, "site-plan", plan.id)} />
        ) : null}
        {canWrite ? (
          <RecordSection id="plan-edit" title={t("places.kit.edit")}>
            {plan.planState !== "Archived" && !trashed ? (
              <SitePlanForm
                org={ctx.org.slug}
                plan={plan}
                projects={projectOptions}
                venues={venueOptions}
                levels={levelOptions}
              />
            ) : null}
            <ActionButton
              action={setPlaceArchivedAction}
              org={ctx.org.slug}
              fields={{ table: "site_plans", id: plan.id, archived: trashed ? "false" : "true" }}
              label={trashed ? t("places.kit.restore") : t("places.plans.moveToTrash")}
              variant={trashed ? "secondary" : "ghost"}
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
  };

  if (peekId && param(search, "full") === "1") {
    return (
      <div className="flex flex-col gap-12">
        <BackLink
          href={withQuery(path, search, {
            peek: undefined,
            full: undefined,
            pin: undefined,
            shape: undefined,
            note: undefined,
          })}
          label={t("places.plans.back")}
        />
        {selected ? (
          <TemplateRecord
            propertiesLabel={t("places.kit.properties")}
            header={
              <header className="flex flex-wrap items-center gap-8 border-b border-border-subtle pb-12">
                <h1 className="m-0 text-heading-24 font-semibold">{selected.title}</h1>
                <Tag>{projectLabel.get(selected.projectId) ?? ""}</Tag>
                {stateChip(selected)}
              </header>
            }
            properties={
              <PropertyList
                items={[
                  { label: t("places.plans.levels.level"), value: levelName(selected) },
                  { label: t("places.plans.pins"), value: String(selected.pins.length) },
                ]}
              />
            }
          >
            {await detail(selected)}
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
          levels={levelOptions}
          {...(projectFilter ? { defaultProjectId: projectFilter } : {})}
        />
      </QueryDrawer>
    );
  } else if (peekId && views.current !== "site-plan") {
    overlay = (
      <QueryDrawer title={t("places.plans.peekTitle")} closeKeys={["peek", "pin", "shape", "note"]}>
        {selected ? (
          <div className="flex flex-col gap-16">
            <div className="flex flex-wrap items-center justify-between gap-8">
              <h3 className="m-0 flex flex-wrap items-center gap-8 text-heading-20 font-semibold">
                {selected.title} {stateChip(selected)}
              </h3>
              <Link
                href={withQuery(path, search, { full: "1" }) as Route}
                className="text-text-13 text-accent-text underline"
              >
                {t("places.kit.openFull")}
              </Link>
            </div>
            {await detail(selected)}
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
  } else if (live.length === 0) {
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
    // The chosen level's Live plan opens first; previous and next step through the levels that have plans.
    const planId = param(search, "plan") ?? peekId;
    const levelOf = (p: SitePlan) => p.venueLevelId ?? "";
    const levelIds = [...new Set(rows.map(levelOf))].sort((a, b) => {
      const la = level.get(a);
      const lb = level.get(b);
      return la && lb ? compareLevels(la, lb) : la ? -1 : lb ? 1 : 0;
    });
    const chosen = rows.find((p) => p.id === planId);
    const levelId = chosen ? levelOf(chosen) : (levelFilter ?? levelIds[0] ?? "");
    const onLevel = rows.filter((p) => levelOf(p) === levelId);
    const current = chosen ?? onLevel.find((p) => p.planState === "Live") ?? onLevel[0] ?? rows[0];
    const at = levelIds.indexOf(levelId);
    const prev = at > 0 ? levelIds[at - 1] : undefined;
    const next = at >= 0 && at < levelIds.length - 1 ? levelIds[at + 1] : undefined;
    const levelLabel = (id: string | undefined) =>
      id ? (level.get(id)?.name ?? "") : t("places.plans.levels.noLevel");
    body = current ? (
      <div className="flex flex-col gap-12">
        <div className="flex flex-wrap items-center gap-8">
          {prev !== undefined ? (
            <Link
              href={
                withQuery(path, search, {
                  level: prev || undefined,
                  plan: undefined,
                  peek: undefined,
                }) as Route
              }
              className="text-text-13 text-accent-text underline"
            >
              {t("places.plans.levels.previous", { level: levelLabel(prev) })}
            </Link>
          ) : null}
          <span className="text-text-13 font-medium">{levelLabel(levelId || undefined)}</span>
          {next !== undefined ? (
            <Link
              href={
                withQuery(path, search, {
                  level: next || undefined,
                  plan: undefined,
                  peek: undefined,
                }) as Route
              }
              className="text-text-13 text-accent-text underline"
            >
              {t("places.plans.levels.next", { level: levelLabel(next) })}
            </Link>
          ) : null}
          <LinkFilter
            path={path}
            search={search}
            label={t("places.plans.showing")}
            queryKey="plan"
            allLabel={current.title}
            options={onLevel.map((p) => ({
              value: p.id,
              label: `${p.title} (${t(`places.plans.states.${p.planState}`)})`,
            }))}
          />
          {stateChip(current)}
        </div>
        {await canvas(current, path, { ...search, plan: current.id })}
        {current.id === peekId ? await thread(current) : null}
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
                  {[
                    p.venueId ? venueName.get(p.venueId) : t("places.plans.fields.noVenue"),
                    levelName(p),
                  ].join(" · ")}
                </span>
                <span>{stateChip(p)}</span>
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
          meta: [
            projectLabel.get(p.projectId),
            p.venueId ? venueName.get(p.venueId) : null,
            levelName(p),
          ]
            .filter(Boolean)
            .join(" · "),
          chips: (
            <>
              {stateChip(p)}
              <Tag>{t("places.plans.pinCount", { count: p.pins.length })}</Tag>
            </>
          ),
        }))}
      />
    );
  }

  const levelChoices = [...levels.data]
    .filter((l) => live.some((p) => p.venueLevelId === l.id))
    .map((l) => ({ value: l.id, label: `${venueName.get(l.venueId) ?? ""} · ${l.name}` }));
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
            label={t("places.plans.state")}
            queryKey="state"
            allLabel={t("places.plans.openStates")}
            options={[
              ...SITE_PLAN_STATES.map((s) => ({ value: s, label: t(`places.plans.states.${s}`) })),
              { value: "all", label: t("places.plans.allStates") },
            ]}
          />
          {levelChoices.length > 0 ? (
            <LinkFilter
              path={path}
              search={search}
              label={t("places.plans.levels.level")}
              queryKey="level"
              allLabel={t("places.plans.levels.all")}
              options={levelChoices}
            />
          ) : null}
          <LinkFilter
            path={path}
            search={search}
            label={t("places.plans.fields.project")}
            queryKey="project"
            allLabel={t("places.plans.allProjects")}
            options={projectOptions.map((p) => ({ value: p.id, label: p.label }))}
          />
        </>
      }
      overlay={overlay}
    >
      {body}
    </Collection>
  );
}
