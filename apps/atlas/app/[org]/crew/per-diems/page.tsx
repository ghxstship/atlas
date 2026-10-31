import { canAddPerDiems, getProjectCurrency, listPerDiems, type PerDiem } from "@xos/data/crew";
import { listCurrencies } from "@xos/data/hospitality";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import { addPerDiemsAction, removePerDiemAction } from "@/app/[org]/crew/actions";
import { ConfirmButton } from "@/components/crew/forms-confirm-button";
import { DrawerForm } from "@/components/crew/forms-drawer-form";
import { CrewFrame, resolveView } from "@/components/crew/frame";
import { CrewRecord } from "@/components/crew/record";
import { FilterSelect } from "@/components/crew/views-filter-select";
import { PeekTable } from "@/components/crew/views-peek-table";
import { collectionPeek } from "@/components/shell/collection-peek";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import { formatMinor } from "@/lib/collection-kit/page";
import { flatParams, getCrewContext, getProjects, withParams } from "@/lib/crew/context";
import { projectPeople, projectPersonLabel } from "@/lib/people/project-people";
import { nodeHref } from "@/lib/shell/sitemap";
import { orgToday } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Crew > Per Diems (Section 4.5.8 Crew Per Diem, R1): one allowance a day for a member or for the
 * person of an engagement, in table and list views, filtered by project and person. Adding a run of
 * days needs a project and crew.time_entry.write; app.add_per_diems refuses days already taken and
 * engagements that are not working. Server components only: the page adds no client bundle.
 */
export default async function Page({ params, searchParams }: PageProps<"/[org]/crew/per-diems">) {
  const routeParams = await params;
  const search = flatParams(await searchParams);
  const node = "crew.per-diems";
  const crew = await getCrewContext(node, routeParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = crew.ctx.viewer.db;
  const view = resolveView(node, search["view"]);
  const base = nodeHref(node, routeParams) ?? "/";
  const projects = await getProjects(crew.ctx);
  const project = crew.project ?? projects.find((p) => p.key === search["project"]) ?? null;
  const [perDiemsResult, currenciesResult] = await Promise.all([
    listPerDiems(db, { orgId: crew.orgId, ...(project ? { projectId: project.id } : {}) }),
    listCurrencies(db),
  ]);
  if (!perDiemsResult.ok) throw new Error(`Cannot list per diems: ${perDiemsResult.error.kind}`);
  if (!currenciesResult.ok) {
    throw new Error(`Cannot list currencies: ${currenciesResult.error.kind}`);
  }
  const exponents = new Map(currenciesResult.data.map((c) => [c.code, c.exponent]));
  const personFilter = search["person"] ?? "";
  const all = perDiemsResult.data;
  const perDiems = personFilter ? all.filter((d) => d.personId === personFilter) : all;
  // Add and Remove show by crew.time_entry.write on the record's project (app.can_add_per_diems), the
  // check add_per_diems and the write policy apply. A project role may grant it, so org reach is not enough.
  const canWriteOn = async (projectId: string) => {
    const result = await canAddPerDiems(db, projectId);
    if (!result.ok) throw new Error(`Cannot check per diem access: ${result.error.kind}`);
    return result.data;
  };
  const canAdd = project !== null && (await canWriteOn(project.id));
  const name = (d: PerDiem) => d.personName ?? t("crew.common.unnamed");
  const day = (d: PerDiem) =>
    format.dateTime(new Date(`${d.day}T12:00:00Z`), {
      timeZone: "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  const amount = (d: PerDiem) =>
    formatMinor(format, d.amountMinor, d.currencyCode, exponents.get(d.currencyCode) ?? 2, "");
  const people = new Map(all.flatMap((d) => (d.personId ? [[d.personId, name(d)] as const] : [])));

  let peek = null;
  const peeked = search["peek"] ? all.find((d) => d.id === search["peek"]) : undefined;
  if (peeked) {
    const canRemove =
      project !== null && peeked.projectId === project.id
        ? canAdd
        : await canWriteOn(peeked.projectId);
    const record = (
      <CrewRecord
        crew={crew}
        mode={search["full"] === "1" ? "full" : "peek"}
        kindLabel={t("crew.perDiems.kind")}
        recordKey={peeked.projectKey}
        title={t("crew.perDiems.recordTitle", { name: name(peeked), day: day(peeked) })}
        historySubject={{ table: "app.per_diems", id: peeked.id }}
        state="active"
        stateLabel={t("crew.perDiems.kind")}
        backHref={withParams(base, search, { peek: null, full: null })}
        actions={
          canRemove ? (
            <ConfirmButton
              label={t("crew.perDiems.remove")}
              title={t("crew.perDiems.confirmRemove")}
              description={t("crew.perDiems.removeHelp")}
              defaultReason=""
              reason={false}
              action={removePerDiemAction}
              hidden={{ org: crew.slug, id: peeked.id }}
              variant="ghost"
            />
          ) : null
        }
        properties={[
          { label: t("crew.perDiems.fields.day"), value: day(peeked) },
          { label: t("crew.perDiems.fields.person"), value: name(peeked) },
          { label: t("crew.fields.project"), value: peeked.projectKey },
          { label: t("crew.perDiems.fields.amount"), value: amount(peeked) },
        ]}
      />
    );
    if (search["full"] === "1") return record;
    peek = record;
  }

  let drawer = null;
  if (search["create"] === "1" && canAdd && project) {
    const [candidates, currency, today] = await Promise.all([
      projectPeople(crew.ctx, project.id),
      getProjectCurrency(db, project.id),
      orgToday(crew.ctx),
    ]);
    // Members, and people engaged on the project while their engagement is Active or Closing.
    const workers = candidates.flatMap((p) => {
      const label = projectPersonLabel(t, p, t("crew.common.unnamed"));
      if (p.membershipId) return [{ value: `m:${p.membershipId}`, label }];
      if (p.engagementId && (p.engagementState === "Active" || p.engagementState === "Closing")) {
        return [{ value: `e:${p.engagementId}`, label }];
      }
      return [];
    });
    drawer = (
      <DrawerForm
        title={t("crew.perDiems.add")}
        submitLabel={t("crew.perDiems.add")}
        action={addPerDiemsAction}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          { kind: "hidden", name: "projectId", value: project.id },
          {
            kind: "select",
            name: "person",
            label: t("crew.perDiems.fields.person"),
            options: workers,
          },
          {
            kind: "date",
            name: "from",
            label: t("crew.perDiems.fields.from"),
            value: today,
            required: true,
          },
          {
            kind: "date",
            name: "to",
            label: t("crew.perDiems.fields.to"),
            value: today,
            required: true,
          },
          {
            kind: "money",
            name: "amount",
            label: t("crew.perDiems.fields.amount"),
            required: true,
            min: "0",
            step: "0.01",
          },
          {
            kind: "select",
            name: "currencyCode",
            label: t("crew.perDiems.fields.currency"),
            value: (currency.ok ? currency.data : null) ?? "USD",
            options: currenciesResult.data.map((c) => ({ value: c.code, label: c.code })),
          },
        ]}
      />
    );
  }

  let body;
  if (perDiems.length === 0) {
    body =
      project || all.length > 0 ? (
        <EmptyStateLink
          icon="Wallet"
          sentence={t("crew.perDiems.empty")}
          actionLabel={canAdd ? t("crew.perDiems.add") : t("crew.common.clearFilter")}
          href={
            canAdd
              ? withParams(base, search, { create: "1" })
              : withParams(base, search, { person: null })
          }
        />
      ) : (
        <p className="m-0 text-text-13 text-text-secondary">{t("crew.perDiems.chooseProject")}</p>
      );
  } else if (view === "table") {
    body = (
      <PeekTable
        caption={t("crew.perDiems.title")}
        columns={[
          { key: "day", label: t("crew.perDiems.fields.day") },
          { key: "person", label: t("crew.perDiems.fields.person") },
          { key: "project", label: t("crew.fields.project"), type: "code" },
          { key: "amount", label: t("crew.perDiems.fields.amount") },
        ]}
        rows={perDiems.map((d) => ({
          id: d.id,
          label: `${name(d)} ${d.day}`,
          day: day(d),
          person: name(d),
          project: d.projectKey,
          amount: amount(d),
        }))}
      />
    );
  } else {
    body = (
      <ul
        aria-label={t("crew.perDiems.title")}
        className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
      >
        {perDiems.map((d) => (
          <li key={d.id}>
            <Link
              href={withParams(base, search, { peek: d.id }) as Route}
              className="flex flex-wrap items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
            >
              <span className="flex flex-col">
                <span className="text-text-13 font-medium">{name(d)}</span>
                <span className="text-text-12 text-text-secondary">
                  {day(d)} · {d.projectKey}
                </span>
              </span>
              <span className="text-text-13 tabular-nums">{amount(d)}</span>
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
      count={perDiems.length}
      view={view}
      {...(canAdd
        ? {
            actions: (
              <ButtonLink
                href={withParams(base, search, { create: "1" })}
                variant="primary"
                size="sm"
              >
                {t("crew.perDiems.add")}
              </ButtonLink>
            ),
          }
        : {})}
      filters={
        <>
          {crew.project ? null : (
            <FilterSelect
              name="project"
              label={t("crew.fields.project")}
              value={project?.key ?? ""}
              options={[
                { value: "", label: t("crew.perDiems.allProjects") },
                ...projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
              ]}
            />
          )}
          <FilterSelect
            name="person"
            label={t("crew.perDiems.fields.person")}
            value={personFilter}
            options={[
              { value: "", label: t("crew.perDiems.allPeople") },
              ...[...people].map(([value, label]) => ({ value, label })),
            ]}
          />
        </>
      }
      peek={
        <>
          {collectionPeek(search["peek"], peek)}
          {drawer}
        </>
      }
    >
      {body}
    </CrewFrame>
  );
}
