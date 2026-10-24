import { listRoleAssignments, staffingHeadcount, type RoleAssignment } from "@xos/data/people";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import { createAssignmentAction, transitionAssignmentAction } from "@/app/[org]/people/actions";
import { ConfirmButton } from "@/components/crew/forms-confirm-button";
import { DrawerForm } from "@/components/crew/forms-drawer-form";
import { CrewFrame, resolveView } from "@/components/crew/frame";
import { CrewRecord } from "@/components/crew/record";
import { PeekTable } from "@/components/crew/views-peek-table";
import { collectionPeek } from "@/components/shell/collection-peek";
import { ButtonLink } from "@/components/ui";
import {
  flatParams,
  getCrewContext,
  getMembers,
  getProjects,
  getRoleTitles,
  withParams,
} from "@/lib/crew/context";
import { workforceRoles } from "@/lib/people/roles";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/**
 * People > Roles (Section 4.5.5, playbook Roles Library): the 61 canon workforce roles with their
 * staffing ratios read from canon, the people assigned to each, and a staffing calculator: enter the
 * occupancy and each ratio role shows the headcount it needs, one click from a requisition (journey 9).
 */
export default async function Page({ params, searchParams }: PageProps<"/[org]/people/roles">) {
  const routeParams = await params;
  const search = flatParams(await searchParams);
  const node = "people.roles";
  const crew = await getCrewContext(node, routeParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = crew.ctx.viewer.db;
  const view = resolveView(node, search["view"]);
  const base = nodeHref(node, routeParams) ?? "/";
  const [roles, requisitionRoles, assignmentsResult] = await Promise.all([
    workforceRoles(crew.ctx),
    getRoleTitles(crew.ctx),
    listRoleAssignments(db, { orgId: crew.orgId }),
  ]);
  if (!assignmentsResult.ok)
    throw new Error(`Cannot list role assignments: ${assignmentsResult.error.kind}`);
  const assignments = assignmentsResult.data;
  const occupancy = Number(search["occupancy"] ?? "");
  const hasOccupancy = Number.isFinite(occupancy) && occupancy > 0;
  const canAssign = crew.can("people.role.write");
  const canRequest = crew.can("people.requisition.write");
  const live = (a: RoleAssignment) => a.state === "Proposed" || a.state === "Active";
  const ratioText = (ratio: number | null, basis: string | null) =>
    ratio !== null
      ? t("people.roles.ratio", { ratio: format.number(ratio) })
      : basis === "fixed per tier"
        ? t("people.roles.fixed")
        : t("people.roles.noRatio");
  const requestHref = (code: string, headcount: number | null) =>
    `/${crew.slug}/people/requisitions?create=1&role=${code}${headcount ? `&headcount=${headcount}` : ""}`;

  let peek = null;
  const peekRole = search["peek"] ? roles.get(search["peek"]) : undefined;
  if (peekRole) {
    const held = assignments.filter((a) => a.roleCode === peekRole.code);
    const need = hasOccupancy ? staffingHeadcount(peekRole.staffingRatio, occupancy) : null;
    const record = (
      <CrewRecord
        crew={crew}
        mode={search["full"] === "1" ? "full" : "peek"}
        kindLabel={t("people.roles.workforceRole")}
        recordKey={peekRole.code}
        title={peekRole.role}
        state={held.some(live) ? "active" : "proposed"}
        stateLabel={t("people.roles.assigned", { count: held.filter(live).length })}
        backHref={withParams(base, search, { peek: null, full: null })}
        actions={
          <>
            {canAssign ? (
              <ButtonLink
                href={withParams(base, search, { assign: peekRole.code })}
                size="sm"
                variant="primary"
              >
                {t("people.assignments.assign")}
              </ButtonLink>
            ) : null}
            {canRequest && requisitionRoles.has(peekRole.code) ? (
              <ButtonLink href={requestHref(peekRole.code, need)} size="sm">
                {t("people.roles.request")}
              </ButtonLink>
            ) : null}
          </>
        }
        properties={[
          { label: t("people.roles.code"), value: peekRole.code },
          { label: t("people.roles.department"), value: peekRole.departmentCode },
          {
            label: t("people.roles.ratioLabel"),
            value: ratioText(peekRole.staffingRatio, peekRole.ratioBasis),
          },
          { label: t("people.roles.kit"), value: peekRole.kitBasis ?? t("people.roles.none") },
          ...(hasOccupancy
            ? [
                {
                  label: t("people.roles.needed", { occupancy: format.number(occupancy) }),
                  value: need === null ? t("people.roles.noAnswer") : format.number(need),
                },
              ]
            : []),
        ]}
      >
        <section aria-labelledby="role-people" className="flex flex-col gap-8">
          <h2 id="role-people" className="m-0 text-text-13 font-semibold">
            {t("people.roles.people")}
          </h2>
          {held.length === 0 ? (
            <p className="m-0 text-text-12 text-text-secondary">{t("people.roles.nobody")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-8 p-0">
              {held.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center justify-between gap-8 rounded-card border border-border-subtle p-8 text-text-12"
                >
                  <span>
                    {t("people.roles.heldLine", {
                      name: a.personName ?? t("crew.common.unnamed"),
                      project: a.projectKey,
                      state: t(`people.states.assignment.${a.state}`),
                    })}
                  </span>
                  {canAssign ? (
                    <span className="flex gap-4">
                      {a.state === "Proposed" ? (
                        <ConfirmButton
                          label={t("people.assignments.start")}
                          title={t("people.assignments.startTitle")}
                          defaultReason={t("people.assignments.startReason")}
                          action={transitionAssignmentAction}
                          hidden={{
                            org: crew.slug,
                            id: a.id,
                            expected: "Proposed",
                            next: "Active",
                          }}
                        />
                      ) : null}
                      {a.state === "Active" ? (
                        <ConfirmButton
                          label={t("people.assignments.complete")}
                          title={t("people.assignments.completeTitle")}
                          defaultReason={t("people.assignments.completeReason")}
                          action={transitionAssignmentAction}
                          hidden={{
                            org: crew.slug,
                            id: a.id,
                            expected: "Active",
                            next: "Complete",
                          }}
                        />
                      ) : null}
                      {live(a) ? (
                        <ConfirmButton
                          label={t("people.assignments.cancel")}
                          title={t("people.assignments.cancelTitle")}
                          defaultReason={t("people.assignments.cancelReason")}
                          action={transitionAssignmentAction}
                          hidden={{ org: crew.slug, id: a.id, expected: a.state, next: "Canceled" }}
                          variant="ghost"
                        />
                      ) : null}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </CrewRecord>
    );
    if (search["full"] === "1") return record;
    peek = record;
  }

  let drawer = null;
  const assignRole = search["assign"] ? roles.get(search["assign"]) : undefined;
  if (assignRole && canAssign) {
    const [projects, members] = await Promise.all([getProjects(crew.ctx), getMembers(crew.ctx)]);
    drawer = (
      <DrawerForm
        title={t("people.assignments.assignRole", { role: assignRole.role })}
        submitLabel={t("people.assignments.assign")}
        action={createAssignmentAction}
        openKeys={["assign"]}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          { kind: "hidden", name: "roleCode", value: assignRole.code },
          {
            kind: "select",
            name: "personId",
            label: t("crew.fields.person"),
            options: members.flatMap((m) =>
              m.personId ? [{ value: m.personId, label: m.name ?? t("crew.common.unnamed") }] : [],
            ),
          },
          {
            kind: "select",
            name: "projectId",
            label: t("crew.fields.project"),
            options: projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` })),
          },
          {
            kind: "select",
            name: "staffingBasis",
            label: t("people.assignments.basis"),
            value:
              assignRole.staffingRatio !== null
                ? "Ratio"
                : assignRole.ratioBasis === "fixed per tier"
                  ? "Fixed"
                  : "Declared",
            help: t("people.assignments.basisHelp"),
            options: ["Declared", "Ratio", "Fixed"].map((b) => ({
              value: b,
              label: t(`people.basis.${b}`),
            })),
          },
          { kind: "date", name: "startsOn", label: t("people.assignments.startsOn") },
          { kind: "date", name: "endsOn", label: t("people.assignments.endsOn") },
        ]}
      />
    );
  }

  const list = [...roles.values()];
  const rows = list.map((r) => ({
    id: r.code,
    code: r.code,
    role: r.role,
    ratio: ratioText(r.staffingRatio, r.ratioBasis),
    kit: r.kitBasis ?? "",
    assigned: assignments.filter((a) => a.roleCode === r.code && live(a)).length,
    ...(hasOccupancy ? { need: staffingHeadcount(r.staffingRatio, occupancy) } : {}),
  }));

  return (
    <CrewFrame
      crew={crew}
      node={node}
      module="people"
      params={routeParams}
      search={search}
      count={list.length}
      view={view}
      filters={
        <form className="flex items-end gap-8">
          {Object.entries(search)
            .filter(([k, v]) => k !== "occupancy" && k !== "peek" && v !== undefined)
            .map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
          <label className="flex flex-col gap-4 text-text-12">
            <span className="font-medium">{t("people.roles.occupancy")}</span>
            <input
              name="occupancy"
              type="number"
              min="1"
              step="1"
              defaultValue={hasOccupancy ? String(occupancy) : ""}
              className="h-control-md w-(--space-64) rounded-control border border-border-control bg-bg-surface px-8 text-text-13 text-text-primary"
            />
          </label>
          <button
            type="submit"
            className="h-control-md rounded-control border border-border-subtle px-12 text-text-13 hover:bg-bg-hover"
          >
            {t("people.roles.calculate")}
          </button>
        </form>
      }
      peek={
        <>
          {collectionPeek(search["peek"], peek)}
          {drawer}
        </>
      }
    >
      <p className="m-0 text-text-12 text-text-secondary">
        {hasOccupancy
          ? t("people.roles.calcHelp", { occupancy: format.number(occupancy) })
          : t("people.roles.intro")}
      </p>
      {view === "list" ? (
        <ul
          aria-label={t("people.roles.caption")}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
        >
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                href={withParams(base, search, { peek: r.id }) as Route}
                className="flex flex-wrap items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
              >
                <span className="flex flex-col">
                  <span className="text-text-13 font-medium">
                    {t("crew.common.pair", { a: r.code, b: r.role })}
                  </span>
                  <span className="text-text-12 text-text-secondary">{r.ratio}</span>
                </span>
                <span className="text-text-12 text-text-secondary">
                  {t("people.roles.assigned", { count: r.assigned })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <PeekTable
          caption={t("people.roles.caption")}
          columns={[
            { key: "code", label: t("people.roles.code"), type: "code" },
            { key: "role", label: t("people.roles.workforceRole") },
            { key: "ratio", label: t("people.roles.ratioLabel") },
            { key: "kit", label: t("people.roles.kit"), wrap: true },
            { key: "assigned", label: t("people.roles.assignedColumn"), type: "number" },
            ...(hasOccupancy
              ? [{ key: "need", label: t("people.roles.neededColumn"), type: "number" as const }]
              : []),
          ]}
          rows={rows}
        />
      )}
    </CrewFrame>
  );
}
