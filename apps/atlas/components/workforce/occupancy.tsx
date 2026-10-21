import {
  listOccupancyCounters,
  listOccupantLoadFactors,
  listProjectSpaces,
  occupancyPercent,
  type OccupancyCounter,
} from "@xos/data/workforce-site";
import { CollectionView } from "@/components/collection-kit/collection-view";
import {
  ActionButton,
  EmptyRefresh,
  EntityForm,
  ErrorPanel,
  FormDrawer,
  KitLink,
  PeekDrawer,
} from "@/components/collection-kit/kit";
import type { KitRow, KitState, ViewKind } from "@/components/collection-kit/types";
import { PageHeader } from "@/components/collection-kit/ui";
import { EmptyStateLink } from "@/components/ui";
import { closeCounterAction, countAction, createCounterAction } from "@/lib/workforce/actions";
import type { Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import { nodeHref } from "@/lib/shell/sitemap";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import { ProjectPicker, REFUSALS, chosenProject, orgPickers, workforceCopy } from "./shared";

const VIEWS: readonly ViewKind[] = ["table", "list"];

function counterState(c: OccupancyCounter, t: Copy): KitState {
  if (c.closedAt) return { state: "complete", label: t("occupancy.closed") };
  if (c.alertLevel >= 100) return { state: "blocked", label: t("occupancy.level", { level: 100 }) };
  if (c.alertLevel >= 80)
    return { state: "in-review", label: t("occupancy.level", { level: c.alertLevel }) };
  return { state: "active", label: t("occupancy.counting") };
}

/**
 * Site Operations > Occupancy (Section 4.9 live occupancy counter): door counts against the permitted
 * occupant load, which comes from a permit, the space's stated capacity or its area over the Bible
 * occupant load factor. Crossing 80, 90 and 100 percent alerts the project's dispatchers.
 */
export async function OccupancySection({
  ctx,
  path,
  search,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
}) {
  const state = collectionState(search, VIEWS, await orgToday(ctx));
  const [t, pickers] = await Promise.all([workforceCopy(), orgPickers(ctx)]);
  const title = t("occupancy.title");
  const project = chosenProject(pickers.projects, search);
  if (project === null) {
    return (
      <>
        <PageHeader title={title} />
        <EmptyStateLink
          icon="FolderPlus"
          sentence={t("site.noProjects")}
          actionLabel={t("site.openProjects")}
          href={nodeHref("projects.all", { org: ctx.org.slug }) ?? "/"}
        />
      </>
    );
  }
  const db = ctx.viewer.db;
  const counters = await listOccupancyCounters(db, project.id);
  const picker = <ProjectPicker t={t} path={path} projects={pickers.projects} current={project} />;
  if (!counters.ok) {
    return (
      <>
        <PageHeader title={title} />
        {picker}
        <ErrorPanel what={t("occupancy.what")} />
      </>
    );
  }
  const canConfigure = ctx.capabilities.has("safety.emergency_code.write");
  const canCount = ctx.role !== "viewer";
  const scoped = {
    ...state,
    baseQuery: new URLSearchParams({
      ...Object.fromEntries(new URLSearchParams(state.baseQuery)),
      project: project.id,
    }).toString(),
  };
  const selected = state.peek ? counters.data.find((c) => c.id === state.peek) : undefined;
  const createHref = withQuery(path, scoped, { create: "1" });

  const countButtons = (c: OccupancyCounter) =>
    canCount && !c.closedAt ? (
      <div
        className="flex flex-wrap gap-8"
        role="group"
        aria-label={t("occupancy.countFor", { name: c.name })}
      >
        {[1, 5, -1, -5].map((d) => (
          <ActionButton
            key={d}
            action={countAction}
            hidden={{ org: ctx.org.slug, id: c.id, delta: String(d) }}
            label={d > 0 ? t("occupancy.in", { count: d }) : t("occupancy.out", { count: -d })}
            variant={d > 0 ? "primary" : "secondary"}
            refusals={REFUSALS}
          />
        ))}
      </div>
    ) : null;

  let drawer = null;
  if (state.create && canConfigure) {
    const [spaces, factors] = await Promise.all([
      listProjectSpaces(db, project.id),
      listOccupantLoadFactors(db),
    ]);
    drawer = (
      <FormDrawer title={t("occupancy.create")} closeHref={withQuery(path, scoped)}>
        <EntityForm
          id="counter-create"
          action={createCounterAction}
          hidden={{ org: ctx.org.slug, projectId: project.id }}
          refusals={REFUSALS}
          submitLabel={t("occupancy.create")}
          successHref={withQuery(path, scoped)}
          fields={[
            { kind: "text", name: "name", label: t("occupancy.name"), required: true },
            {
              kind: "select",
              name: "spaceId",
              label: t("occupancy.space"),
              blankLabel: t("occupancy.noSpace"),
              options: (spaces.ok ? spaces.data : []).map((s) => ({
                value: s.id,
                label: t("occupancy.spaceOption", {
                  name: s.name,
                  area: s.areaSqFt ?? 0,
                  capacity: s.capacity ?? 0,
                }),
              })),
            },
            {
              kind: "select",
              name: "metricItem",
              label: t("occupancy.factor"),
              help: t("occupancy.factorHelp"),
              blankLabel: t("occupancy.noFactor"),
              options: (factors.ok ? factors.data : []).map((f) => ({
                value: f.item,
                label: t("occupancy.factorOption", { item: f.item, feet: f.squareFeetPerPerson }),
              })),
            },
            {
              kind: "number",
              name: "permittedLoad",
              label: t("occupancy.permit"),
              help: t("occupancy.permitHelp"),
            },
          ]}
        />
      </FormDrawer>
    );
  } else if (selected) {
    drawer = (
      <PeekDrawer
        recordKey={project.key}
        title={selected.name}
        state={counterState(selected, t)}
        closeHref={withQuery(path, scoped)}
        fullHref={withQuery(path, scoped, { peek: selected.id })}
        properties={[
          {
            label: t("occupancy.inside"),
            value: t("occupancy.ratio", {
              count: selected.count,
              load: selected.permittedLoad,
              percent: occupancyPercent(selected),
            }),
          },
          {
            label: t("occupancy.basis"),
            value: t(`occupancy.bases.${selected.basis.replaceAll(" ", "")}`),
          },
          { label: t("occupancy.factor"), value: selected.metricItem ?? t("occupancy.noFactor") },
        ]}
        actions={
          canConfigure && !selected.closedAt ? (
            <ActionButton
              action={closeCounterAction}
              hidden={{ org: ctx.org.slug, id: selected.id }}
              label={t("occupancy.close")}
              variant="danger"
              confirm={{
                title: t("occupancy.closeTitle", { name: selected.name }),
                body: t("occupancy.closeBody"),
              }}
              refusals={REFUSALS}
            />
          ) : null
        }
      >
        <p role="status" className="m-0 text-text-24 font-semibold">
          {t("occupancy.ratio", {
            count: selected.count,
            load: selected.permittedLoad,
            percent: occupancyPercent(selected),
          })}
        </p>
        {countButtons(selected)}
      </PeekDrawer>
    );
  }

  const rows: KitRow[] = counters.data.map((c) => ({
    id: c.id,
    key: project.key,
    title: c.name,
    state: counterState(c, t),
    meta: t("occupancy.ratio", {
      count: c.count,
      load: c.permittedLoad,
      percent: occupancyPercent(c),
    }),
    cells: {
      name: c.name,
      state: counterState(c, t),
      count: c.count,
      load: c.permittedLoad,
      percent: occupancyPercent(c),
      basis: t(`occupancy.bases.${c.basis.replaceAll(" ", "")}`),
    },
  }));
  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "name", label: t("occupancy.name"), wrap: true },
        { key: "state", label: t("feed.state"), type: "state" },
        { key: "count", label: t("occupancy.inside"), type: "number" },
        { key: "load", label: t("occupancy.load"), type: "number" },
        { key: "percent", label: t("occupancy.percent"), type: "number" },
        { key: "basis", label: t("occupancy.basis") },
      ]}
      rows={rows}
      filters={picker}
      actions={
        canConfigure ? (
          <KitLink href={createHref} variant="primary">
            {t("occupancy.create")}
          </KitLink>
        ) : null
      }
      empty={
        canConfigure ? (
          <EmptyStateLink
            icon="Users"
            sentence={t("occupancy.empty")}
            actionLabel={t("occupancy.create")}
            href={createHref}
            secondary
          />
        ) : (
          <EmptyRefresh icon="Users" sentence={t("occupancy.emptyRead")} />
        )
      }
    >
      {drawer}
    </CollectionView>
  );
}
