import { getRateCanon, listCurrencies } from "@xos/data/crew";
import {
  getRequisition,
  listPeopleRequisitions,
  REQUISITION_STATES,
  type Requisition,
} from "@xos/data/people";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import {
  approveRequisitionAction,
  createRequisitionAction,
  rejectRequisitionAction,
  transitionRequisitionAction,
  updateRequisitionAction,
} from "@/app/[org]/people/actions";
import { ConfirmButton } from "@/components/crew/forms-confirm-button";
import { DrawerForm } from "@/components/crew/forms-drawer-form";
import { type FieldSpec } from "@/components/crew/forms.types";
import { CrewFrame, resolveView } from "@/components/crew/frame";
import { CrewRecord } from "@/components/crew/record";
import { FilterSelect } from "@/components/crew/views-filter-select";
import { PeekBoard } from "@/components/crew/views-peek-board";
import { PeekTable } from "@/components/crew/views-peek-table";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import {
  flatParams,
  getCrewContext,
  getProjects,
  getRoleTitles,
  withParams,
} from "@/lib/crew/context";
import { money } from "@/lib/crew/format";
import { fromMinor } from "@/lib/crew/money";
import { peopleStateIcon } from "@/lib/people/states";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

const ROLE_TYPES = ["Crew", "Staff", "Contractor", "Artist", "Vendor"] as const;

/**
 * People > Requisitions (Section 4.5.5, playbook Staffing Requisition): requests to staff a canon role
 * on a project, priced in minor units (a blank rate is unpriced and is never approved). Approval runs
 * spend authority and is never by the requester; an Approved requisition is what Opportunities
 * publishes as a posting (journeys 9 and 41).
 */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/people/requisitions">) {
  const routeParams = await params;
  const search = flatParams(await searchParams);
  const node = "people.requisitions";
  const crew = await getCrewContext(node, routeParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = crew.ctx.viewer.db;
  const view = resolveView(node, search["view"]);
  const base = nodeHref(node, routeParams) ?? "/";
  const [projects, roles] = await Promise.all([getProjects(crew.ctx), getRoleTitles(crew.ctx)]);
  const projectFilter = projects.find((p) => p.key === search["project"]) ?? null;
  const stateFilter = REQUISITION_STATES.find((s) => s === search["state"]);
  const result = await listPeopleRequisitions(db, {
    orgId: crew.orgId,
    ...(projectFilter ? { projectId: projectFilter.id } : {}),
    ...(stateFilter ? { states: [stateFilter] } : {}),
  });
  if (!result.ok) throw new Error(`Cannot list requisitions: ${result.error.kind}`);
  const requisitions = result.data;
  const canWrite = crew.can("people.requisition.write");
  const canApprove = crew.can("people.requisition.approve");
  const me = crew.ctx.viewer.person?.id ?? null;
  const roleName = (code: string) =>
    t("crew.common.pair", { a: code, b: roles.get(code)?.title ?? code });
  const title = (r: Requisition) =>
    t("people.requisitions.title", {
      count: r.headcount,
      role: roles.get(r.roleCode)?.title ?? r.roleCode,
    });
  const estimate = (r: Requisition) => money(format, t, r.estimatedMinor, r.currencyCode);

  let peek = null;
  let editing: Requisition | null = null;
  const lookup = search["peek"] ?? search["edit"];
  if (lookup) {
    const detail = await getRequisition(db, lookup);
    if (detail.ok) {
      const r = detail.data;
      editing = r;
      if (search["peek"]) {
        const mine = r.requestedBy === me;
        const hidden = { org: crew.slug, id: r.id };
        const record = (
          <CrewRecord
            crew={crew}
            mode={search["full"] === "1" ? "full" : "peek"}
            kindLabel={t("people.kinds.requisition")}
            recordKey={r.projectKey}
            title={title(r)}
            state={peopleStateIcon("requisition", r.state)}
            stateLabel={t(`people.states.requisition.${r.state}`)}
            stateName={(v) => t(`people.states.requisition.${v}`)}
            history={r.transitions}
            subject={{ table: "app.requisitions", id: r.id }}
            backHref={withParams(base, search, { peek: null, full: null })}
            actions={
              <>
                {r.state === "Proposed" && canApprove && !mine ? (
                  <>
                    <ConfirmButton
                      label={t("crew.swapsPage.approve")}
                      title={t("people.requisitions.approveTitle", { amount: estimate(r) })}
                      description={t("people.requisitions.approveHelp")}
                      defaultReason={t("people.requisitions.approveReason")}
                      action={approveRequisitionAction}
                      hidden={hidden}
                      variant="primary"
                    />
                    <ConfirmButton
                      label={t("crew.swapsPage.reject")}
                      title={t("people.requisitions.rejectTitle")}
                      defaultReason={t("people.requisitions.rejectReason")}
                      action={rejectRequisitionAction}
                      hidden={hidden}
                    />
                  </>
                ) : null}
                {r.state === "Proposed" && (canWrite || mine) ? (
                  <ButtonLink
                    href={withParams(base, search, { peek: null, full: null, edit: r.id })}
                    size="sm"
                  >
                    {t("crew.common.edit")}
                  </ButtonLink>
                ) : null}
                {r.state === "Rejected" && (canWrite || mine) ? (
                  <ConfirmButton
                    label={t("people.requisitions.resubmit")}
                    title={t("people.requisitions.resubmitTitle")}
                    defaultReason={t("people.requisitions.resubmitReason")}
                    action={transitionRequisitionAction}
                    hidden={{ ...hidden, expected: "Rejected", next: "Proposed" }}
                  />
                ) : null}
                {r.state === "Approved" ? (
                  <ButtonLink
                    href={`/${crew.slug}/opportunities/postings?create=1&requisition=${r.id}`}
                    size="sm"
                    variant="primary"
                  >
                    {t("people.requisitions.publish")}
                  </ButtonLink>
                ) : null}
                {r.state === "Approved" && canWrite ? (
                  <ConfirmButton
                    label={t("people.requisitions.fill")}
                    title={t("people.requisitions.fillTitle")}
                    defaultReason={t("people.requisitions.fillReason")}
                    action={transitionRequisitionAction}
                    hidden={{ ...hidden, expected: "Approved", next: "Filled" }}
                  />
                ) : null}
                {(r.state === "Proposed" || r.state === "Approved") && (canWrite || mine) ? (
                  <ConfirmButton
                    label={t("people.requisitions.cancel")}
                    title={t("people.requisitions.cancelTitle")}
                    defaultReason={t("people.requisitions.cancelReason")}
                    action={transitionRequisitionAction}
                    hidden={{ ...hidden, expected: r.state, next: "Canceled" }}
                    variant="ghost"
                  />
                ) : null}
              </>
            }
            properties={[
              { label: t("crew.fields.project"), value: r.projectKey },
              { label: t("crew.fields.role"), value: roleName(r.roleCode) },
              { label: t("people.requisitions.headcount"), value: format.number(r.headcount) },
              {
                label: t("people.requisitions.terms"),
                value: r.payBasis
                  ? t("people.requisitions.termsValue", {
                      classification: r.workerClassification ?? "",
                      basis: r.payBasis,
                      arrangement: r.arrangement ?? "",
                    })
                  : t("people.requisitions.noTerms"),
              },
              {
                label: t("people.requisitions.units"),
                value:
                  r.unitsPerHead === null
                    ? t("people.requisitions.unknown")
                    : format.number(r.unitsPerHead),
              },
              { label: t("crew.rates.rate"), value: money(format, t, r.rateMinor, r.currencyCode) },
              { label: t("people.requisitions.estimate"), value: estimate(r) },
              {
                label: t("people.requisitions.roleType"),
                value: r.roleType
                  ? t(`people.roleTypes.${r.roleType}`)
                  : t("people.requisitions.internal"),
              },
              {
                label: t("people.requisitions.dates"),
                value: r.startsOn
                  ? t("crew.common.range", { start: r.startsOn, end: r.endsOn ?? r.startsOn })
                  : t("people.requisitions.unknown"),
              },
            ]}
          >
            <section aria-labelledby="req-justification" className="flex flex-col gap-4">
              <h2 id="req-justification" className="m-0 text-text-13 font-semibold">
                {t("people.requisitions.justification")}
              </h2>
              <p className="m-0 whitespace-pre-wrap text-text-13">{r.justification}</p>
            </section>
            {r.assignments.length > 0 ? (
              <section aria-labelledby="req-assignments" className="flex flex-col gap-4">
                <h2 id="req-assignments" className="m-0 text-text-13 font-semibold">
                  {t("people.requisitions.filledBy")}
                </h2>
                <ul className="m-0 flex list-none flex-col gap-2 p-0 text-text-12">
                  {r.assignments.map((a) => (
                    <li key={a.id}>
                      {t("crew.common.pair", {
                        a: a.personName ?? t("crew.common.unnamed"),
                        b: t(`people.states.assignment.${a.state}`),
                      })}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </CrewRecord>
        );
        if (search["full"] === "1") return record;
        peek = record;
      }
    } else if (detail.error.kind !== "not-found") {
      throw new Error(`Cannot read requisition: ${detail.error.kind}`);
    }
  }

  let drawer = null;
  const creating = search["create"] === "1" && canWrite && projects.length > 0;
  if (creating || (editing && search["edit"])) {
    const [canon, currencies] = await Promise.all([getRateCanon(db), listCurrencies(db)]);
    const role = editing?.roleCode ?? search["role"] ?? "";
    const combos = canon.ok
      ? canon.data.canonRateCards.filter((c) => role === "" || c.roleCode === role)
      : [];
    const fields: FieldSpec[] = [
      { kind: "hidden", name: "org", value: crew.slug },
      ...(editing ? [{ kind: "hidden" as const, name: "id", value: editing.id }] : []),
      ...(editing
        ? []
        : [
            {
              kind: "select" as const,
              name: "projectId",
              label: t("crew.fields.project"),
              value: projectFilter?.id ?? projects[0]?.id ?? "",
              options: projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` })),
            },
          ]),
      {
        kind: "select",
        name: "roleCode",
        label: t("crew.fields.role"),
        value: role,
        options: [...roles.values()].map((r) => ({
          value: r.code,
          label: `${r.code} · ${r.title}`,
        })),
      },
      {
        kind: "number",
        name: "headcount",
        label: t("people.requisitions.headcount"),
        value: String(editing?.headcount ?? search["headcount"] ?? 1),
        min: "1",
        step: "1",
        required: true,
        help: t("people.requisitions.headcountHelp"),
      },
      {
        kind: "select",
        name: "roleType",
        label: t("people.requisitions.roleType"),
        value: editing?.roleType ?? "",
        options: [
          { value: "", label: t("people.requisitions.internal") },
          ...ROLE_TYPES.map((x) => ({ value: x, label: t(`people.roleTypes.${x}`) })),
        ],
      },
      {
        kind: "select",
        name: "rateCard",
        label: t("people.requisitions.terms"),
        value: editing?.payBasis
          ? `${editing.workerClassification}|${editing.payBasis}|${editing.arrangement}`
          : "",
        help: t("people.requisitions.termsHelp"),
        options: [
          { value: "", label: t("people.requisitions.noTerms") },
          ...combos.map((c) => ({
            value: `${c.classification}|${c.payBasis}|${c.arrangement}`,
            label: t("people.requisitions.comboOption", {
              id: c.id,
              role: c.roleCode,
              classification: c.classification,
              basis: c.payBasis,
              arrangement: c.arrangement,
            }),
          })),
        ],
      },
      {
        kind: "number",
        name: "unitsPerHead",
        label: t("people.requisitions.units"),
        value:
          editing?.unitsPerHead === null || editing?.unitsPerHead === undefined
            ? ""
            : String(editing.unitsPerHead),
        step: "0.25",
        min: "0",
        help: t("people.requisitions.unitsHelp"),
      },
      {
        kind: "select",
        name: "currencyCode",
        label: t("crew.rates.currency"),
        value: editing?.currencyCode ?? "USD",
        options: (currencies.ok ? currencies.data : ["USD"]).map((c) => ({ value: c, label: c })),
      },
      {
        kind: "money",
        name: "rate",
        label: t("people.requisitions.rateLabel"),
        value: editing ? fromMinor(editing.rateMinor, 2) : "",
        help: t("crew.rates.rateHelp"),
      },
      {
        kind: "date",
        name: "startsOn",
        label: t("people.requisitions.startsOn"),
        value: editing?.startsOn ?? "",
      },
      {
        kind: "date",
        name: "endsOn",
        label: t("people.requisitions.endsOn"),
        value: editing?.endsOn ?? "",
      },
      {
        kind: "textarea",
        name: "justification",
        label: t("people.requisitions.justification"),
        value: editing?.justification ?? "",
        required: true,
      },
    ];
    drawer =
      editing && search["edit"] ? (
        <DrawerForm
          title={t("people.requisitions.editTitle")}
          submitLabel={t("crew.common.save")}
          action={updateRequisitionAction}
          fields={fields}
        />
      ) : (
        <DrawerForm
          title={t("people.requisitions.createTitle")}
          submitLabel={t("people.requisitions.create")}
          action={createRequisitionAction}
          fields={fields}
          openKeys={["create", "role", "headcount"]}
        />
      );
  }

  let body;
  if (requisitions.length === 0) {
    body = (
      <EmptyStateLink
        icon="UserPlus"
        sentence={
          stateFilter || projectFilter
            ? t("crew.swapsPage.emptyFiltered")
            : canWrite
              ? t("people.requisitions.emptyWriter")
              : t("people.requisitions.emptyReader")
        }
        actionLabel={
          stateFilter || projectFilter
            ? t("crew.common.clearFilter")
            : canWrite
              ? t("people.requisitions.create")
              : t("people.requisitions.viewRoles")
        }
        href={
          stateFilter || projectFilter
            ? withParams(base, search, { state: null, project: null })
            : canWrite
              ? withParams(base, search, { create: "1" })
              : `/${crew.slug}/people/roles`
        }
      />
    );
  } else if (view === "board") {
    body = (
      <PeekBoard
        columns={REQUISITION_STATES.map((st) => ({
          state: peopleStateIcon("requisition", st),
          label: t(`people.states.requisition.${st}`),
          cards: requisitions
            .filter((r) => r.state === st)
            .map((r) => ({
              key: r.id,
              title: title(r),
              meta: t("crew.common.pair", { a: r.projectKey, b: estimate(r) }),
            })),
        }))}
      />
    );
  } else if (view === "list") {
    body = (
      <ul
        aria-label={t("people.requisitions.caption")}
        className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
      >
        {requisitions.map((r) => (
          <li key={r.id}>
            <Link
              href={withParams(base, search, { peek: r.id }) as Route}
              className="flex flex-wrap items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
            >
              <span className="flex flex-col">
                <span className="text-text-13 font-medium">{title(r)}</span>
                <span className="text-text-12 text-text-secondary">
                  {t("crew.common.pair", { a: r.projectKey, b: estimate(r) })}
                </span>
              </span>
              <span className="text-text-12 text-text-secondary">
                {t(`people.states.requisition.${r.state}`)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <PeekTable
        caption={t("people.requisitions.caption")}
        columns={[
          { key: "project", label: t("crew.fields.project"), type: "code" },
          { key: "role", label: t("crew.fields.role"), wrap: true },
          { key: "headcount", label: t("people.requisitions.headcount"), type: "number" },
          { key: "estimate", label: t("people.requisitions.estimate") },
          { key: "state", label: t("crew.fields.state"), type: "state" },
        ]}
        rows={requisitions.map((r) => ({
          id: r.id,
          project: r.projectKey,
          role: roleName(r.roleCode),
          headcount: r.headcount,
          estimate: estimate(r),
          state: {
            state: peopleStateIcon("requisition", r.state),
            label: t(`people.states.requisition.${r.state}`),
          },
        }))}
      />
    );
  }

  return (
    <CrewFrame
      crew={crew}
      node={node}
      module="people"
      params={routeParams}
      search={search}
      count={requisitions.length}
      view={view}
      {...(canWrite && projects.length > 0
        ? {
            actions: (
              <ButtonLink
                href={withParams(base, search, { create: "1" })}
                variant="primary"
                size="sm"
              >
                {t("people.requisitions.create")}
              </ButtonLink>
            ),
          }
        : {})}
      filters={
        <>
          <FilterSelect
            name="project"
            label={t("crew.fields.project")}
            value={projectFilter?.key ?? ""}
            options={[
              { value: "", label: t("crew.common.allProjects") },
              ...projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
            ]}
          />
          <FilterSelect
            name="state"
            label={t("crew.fields.state")}
            value={stateFilter ?? ""}
            options={[
              { value: "", label: t("crew.common.allStates") },
              ...REQUISITION_STATES.map((v) => ({
                value: v,
                label: t(`people.states.requisition.${v}`),
              })),
            ]}
          />
        </>
      }
      peek={
        <>
          {peek}
          {drawer}
        </>
      }
    >
      {body}
    </CrewFrame>
  );
}
