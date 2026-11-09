import {
  listAgencyEngagements,
  listAssignableRosterEntries,
  listPositions,
  type AgencyEngagement,
  type ProjectPosition,
} from "@xos/data/crew";
import type { Route } from "next";
import Link from "next/link";
import {
  fillPositionAction,
  savePositionAction,
  trashPositionAction,
  vacatePositionAction,
} from "@/app/[org]/crew/coverage-actions";
import { ConfirmButton } from "@/components/crew/forms-confirm-button";
import { type FieldSpec } from "@/components/crew/forms.types";
import { CrewFrame, resolveView } from "@/components/crew/frame";
import { DrawerForm, PeekTable } from "@/components/crew/lazy";
import { CrewRecord } from "@/components/crew/record";
import { InlineAlert } from "@/components/crew/ui";
import { FilterSelect } from "@/components/crew/views-filter-select";
import { collectionPeek } from "@/components/shell/collection-peek";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import {
  flatParams,
  getCrewContext,
  getMembers,
  getProjects,
  getRoleTitles,
  withParams,
} from "@/lib/crew/context";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Crew > Positions (B9, ADR 0148 decision 3): seats on a project filled later by one member or one person of an agency's
 * roster, with the shifts and records planned against them. Distinct from a listing's positions and from Gateway's agency
 * slots. A planner adds a position, fills it (one picker) and vacates it with a reason; what filling did shows as a
 * notice on the page, since the drawer leaves after the refresh.
 */
export default async function Page({ params, searchParams }: PageProps<"/[org]/crew/positions">) {
  const routeParams = await params;
  const search = flatParams(await searchParams);
  const node = "crew.positions";
  const crew = await getCrewContext(node, routeParams);
  const t = await getTranslate();
  const db = crew.ctx.viewer.db;
  const view = resolveView(node, search["view"]);
  const base = nodeHref(node, routeParams) ?? "/";
  const [projects, roles] = await Promise.all([getProjects(crew.ctx), getRoleTitles(crew.ctx)]);
  const projectFilter = crew.project ?? projects.find((p) => p.key === search["project"]) ?? null;
  const canWrite = crew.can("crew.shift.write");
  const result = await listPositions(db, {
    orgId: crew.orgId,
    ...(projectFilter ? { projectId: projectFilter.id } : {}),
  });
  if (!result.ok) throw new Error(`Cannot list positions: ${result.error.kind}`);
  const positions = result.data;
  const peekHref = (id: string) => withParams(base, search, { peek: id, full: null });
  const roleName = (code: string | null) =>
    code === null ? t("crew.common.noRole") : (roles.get(code)?.title ?? code);
  const holderName = (p: ProjectPosition) =>
    p.holder ? (p.holder.name ?? t("crew.common.unnamed")) : t("crew.positions.unfilled");
  const agencyName = (p: ProjectPosition) =>
    p.engagementId ? (p.agencyName ?? t("crew.agency.slotUnnamed")) : t("crew.positions.noAgency");

  // Agencies load only while the editor is open.
  const editing = search["edit"] ? (positions.find((p) => p.id === search["edit"]) ?? null) : null;
  const editorOpen = canWrite && (search["create"] === "1" || editing !== null);
  const agencyProjects = editorOpen
    ? editing
      ? projects.filter((p) => p.id === editing.projectId)
      : projectFilter
        ? [projectFilter]
        : projects
    : [];
  const agencyLists = await Promise.all(
    agencyProjects.map(async (p) => {
      const list = await listAgencyEngagements(db, p.id);
      if (!list.ok) throw new Error(`Cannot read the agencies: ${list.error.kind}`);
      return list.data.map((a: AgencyEngagement) => ({ project: p, agency: a }));
    }),
  );
  const positionFields = (p: ProjectPosition | null): FieldSpec[] => [
    { kind: "hidden", name: "org", value: crew.slug },
    ...(p ? [{ kind: "hidden" as const, name: "id", value: p.id }] : []),
    ...(p || projectFilter
      ? [
          {
            kind: "hidden" as const,
            name: "projectId",
            value: p?.projectId ?? projectFilter?.id ?? "",
          },
        ]
      : [
          {
            kind: "select" as const,
            name: "projectId",
            label: t("crew.fields.project"),
            value: projects[0]?.id ?? "",
            options: projects.map((x) => ({ value: x.id, label: `${x.key} · ${x.name}` })),
          },
        ]),
    {
      kind: "text",
      name: "title",
      label: t("crew.positions.title"),
      value: p?.title ?? "",
      required: true,
      help: t("crew.positions.titleHelp"),
    },
    {
      kind: "select",
      name: "roleCode",
      label: t("crew.fields.role"),
      value: p?.roleCode ?? "",
      options: [
        { value: "", label: t("crew.common.noRole") },
        ...[...roles.values()].map((r) => ({ value: r.code, label: `${r.code} · ${r.title}` })),
      ],
    },
    {
      kind: "select",
      name: "engagementId",
      label: t("crew.positions.agency"),
      value: p?.engagementId ?? "",
      help: t("crew.positions.agencyHelp"),
      options: [
        { value: "", label: t("crew.positions.noAgency") },
        ...agencyLists.flat().map(({ project, agency }) => ({
          value: agency.engagementId,
          label: `${project.key} · ${agency.accountName ?? t("crew.agency.slotUnnamed")}`,
        })),
      ],
    },
  ];

  // The fill picker: the org's members for a member position, the agency's roster for an agency position.
  const filling = search["fill"] ? (positions.find((p) => p.id === search["fill"]) ?? null) : null;
  let fillOptions: Array<{ value: string; label: string }> = [];
  if (filling && canWrite) {
    if (filling.engagementId) {
      const staff = await listAssignableRosterEntries(db, {
        engagementIds: [filling.engagementId],
      });
      if (!staff.ok) throw new Error(`Cannot read the agency's staff: ${staff.error.kind}`);
      fillOptions = staff.data.map((e) => {
        const values = { name: e.name ?? t("crew.common.unnamed"), account: e.accountName ?? "" };
        return {
          value: `r:${e.rosterEntryId}`,
          label:
            e.training.due > 0
              ? t("crew.agency.staffTrainingDue", values)
              : t("crew.agency.staffOption", values),
        };
      });
    } else {
      const members = await getMembers(crew.ctx);
      fillOptions = members.map((m) => ({
        value: `m:${m.membershipId}`,
        label: m.name ?? t("crew.common.unnamed"),
      }));
    }
  }

  const drawer =
    search["create"] === "1" && canWrite && projects.length > 0 ? (
      <DrawerForm
        title={t("crew.positions.createTitle")}
        submitLabel={t("crew.positions.create")}
        action={savePositionAction}
        fields={positionFields(null)}
      />
    ) : editing && canWrite ? (
      <DrawerForm
        title={t("crew.positions.editTitle")}
        submitLabel={t("crew.common.save")}
        action={savePositionAction}
        fields={positionFields(editing)}
      />
    ) : filling && canWrite ? (
      <DrawerForm
        title={t("crew.positions.fillTitle", { title: filling.title })}
        submitLabel={t("crew.positions.fill")}
        action={fillPositionAction}
        openKeys={["fill"]}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          { kind: "hidden", name: "id", value: filling.id },
          {
            kind: "hidden",
            name: "back",
            value: withParams(base, search, { fill: null }),
          },
          {
            kind: "select",
            name: "holder",
            label: t(
              filling.engagementId ? "crew.positions.holderStaff" : "crew.positions.holderMember",
            ),
            help: t("crew.positions.fillHelp"),
            options: fillOptions,
          },
        ]}
      />
    ) : null;

  let peek = null;
  const peekPosition = search["peek"] ? positions.find((p) => p.id === search["peek"]) : null;
  if (peekPosition) {
    const p = peekPosition;
    const record = (
      <CrewRecord
        crew={crew}
        mode={search["full"] === "1" ? "full" : "peek"}
        kindLabel={t("crew.kinds.position")}
        recordKey={p.projectKey}
        title={p.title}
        state={p.holder ? "ready" : "proposed"}
        stateLabel={p.holder ? t("crew.positions.filled") : t("crew.positions.unfilled")}
        backHref={withParams(base, search, { peek: null, full: null })}
        actions={
          canWrite ? (
            <>
              {p.holder ? (
                <ConfirmButton
                  label={t("crew.positions.vacate")}
                  title={t("crew.positions.vacateTitle", { title: p.title })}
                  description={t("crew.positions.vacateHelp")}
                  defaultReason={t("crew.positions.vacateReason")}
                  action={vacatePositionAction}
                  hidden={{ org: crew.slug, id: p.id }}
                />
              ) : (
                <ButtonLink href={withParams(base, search, { fill: p.id })} size="sm">
                  {t("crew.positions.fill")}
                </ButtonLink>
              )}
              <ButtonLink href={withParams(base, search, { edit: p.id })} size="sm">
                {t("crew.common.edit")}
              </ButtonLink>
              <ConfirmButton
                label={t("crew.common.trash")}
                title={t("crew.positions.trashTitle", { title: p.title })}
                description={t("crew.positions.trashHelp")}
                defaultReason=""
                reason={false}
                action={trashPositionAction}
                hidden={{ org: crew.slug, id: p.id }}
                variant="ghost"
              />
            </>
          ) : null
        }
        properties={[
          { label: t("crew.fields.project"), value: `${p.projectKey} · ${p.projectName}` },
          { label: t("crew.fields.role"), value: roleName(p.roleCode) },
          { label: t("crew.positions.agency"), value: agencyName(p) },
          { label: t("crew.positions.holder"), value: holderName(p) },
          { label: t("crew.positions.shifts"), value: String(p.shiftCount) },
          { label: t("crew.positions.records"), value: String(p.recordCount) },
        ]}
      />
    );
    if (search["full"] === "1") return record;
    peek = record;
  }

  const notice =
    search["filled"] !== undefined ? (
      <InlineAlert
        tone={
          Number(search["skipped"] ?? 0) + Number(search["warned"] ?? 0) > 0 ? "warning" : "success"
        }
        title={t("crew.positions.filledNotice")}
      >
        {t("crew.positions.filledSummary", {
          filled: Number(search["filled"] ?? 0),
          skipped: Number(search["skipped"] ?? 0),
          warned: Number(search["warned"] ?? 0),
          records: Number(search["records"] ?? 0),
        })}
      </InlineAlert>
    ) : null;

  let body;
  if (positions.length === 0) {
    body =
      canWrite && projects.length > 0 ? (
        <EmptyStateLink
          icon="Users"
          sentence={t("crew.positions.empty")}
          actionLabel={t("crew.positions.create")}
          href={withParams(base, search, { create: "1" })}
          secondary
        />
      ) : (
        <p className="m-0 text-text-13 text-text-secondary">{t("crew.positions.emptyReader")}</p>
      );
  } else if (view === "table") {
    body = (
      <PeekTable
        caption={t("crew.positions.caption")}
        columns={[
          { key: "title", label: t("crew.positions.title") },
          { key: "project", label: t("crew.fields.project"), type: "code" },
          { key: "role", label: t("crew.fields.role") },
          { key: "agency", label: t("crew.positions.agency") },
          { key: "holder", label: t("crew.positions.holder") },
          { key: "shifts", label: t("crew.positions.shifts"), type: "number" },
          { key: "records", label: t("crew.positions.records"), type: "number" },
        ]}
        rows={positions.map((p) => ({
          id: p.id,
          title: p.title,
          project: p.projectKey,
          role: roleName(p.roleCode),
          agency: agencyName(p),
          holder: holderName(p),
          shifts: p.shiftCount,
          records: p.recordCount,
        }))}
      />
    );
  } else {
    body = (
      <ul
        aria-label={t("crew.positions.caption")}
        className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
      >
        {positions.map((p) => (
          <li key={p.id}>
            <Link
              href={peekHref(p.id) as Route}
              className="flex flex-wrap items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
            >
              <span className="flex flex-col">
                <span className="text-text-13 font-medium">{p.title}</span>
                <span className="text-text-12 text-text-secondary">
                  {t("crew.common.pair", { a: p.projectKey, b: roleName(p.roleCode) })}
                </span>
              </span>
              <span className="text-text-12 text-text-secondary">{holderName(p)}</span>
            </Link>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <CrewFrame
      crew={crew}
      node={node}
      module="crew"
      params={routeParams}
      search={search}
      count={positions.length}
      view={view}
      {...(canWrite && projects.length > 0
        ? {
            actions: (
              <ButtonLink
                href={withParams(base, search, { create: "1" })}
                variant="primary"
                size="sm"
              >
                {t("crew.positions.create")}
              </ButtonLink>
            ),
          }
        : {})}
      {...(crew.project
        ? {}
        : {
            filters: (
              <FilterSelect
                name="project"
                label={t("crew.fields.project")}
                value={projectFilter?.key ?? ""}
                options={[
                  { value: "", label: t("crew.common.allProjects") },
                  ...projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
                ]}
              />
            ),
          })}
      peek={
        <>
          {collectionPeek(search["peek"], peek)}
          {drawer}
        </>
      }
    >
      {notice}
      {body}
    </CrewFrame>
  );
}
