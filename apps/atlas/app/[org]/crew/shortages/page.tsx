import { SHORTAGE_KINDS, listShortages, shortageCounts, type Shortage } from "@xos/data/crew";
import { todayIn } from "@xos/data/calendar";
import type { Route } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getFormatter } from "next-intl/server";
import { CrewFrame, resolveView } from "@/components/crew/frame";
import { FilterDate } from "@/components/crew/views-filter-date";
import { FilterSelect } from "@/components/crew/views-filter-select";
import { PeekTable } from "@/components/crew/views-peek-table";
import { EmptyStateLink, InlineAlert } from "@/components/ui";
import { flatParams, getCrewContext, getRoleTitles, withParams } from "@/lib/crew/context";
import { addDays, dayIn, isIsoDate } from "@/lib/crew/time";
import { getOrgTimeZone } from "@/lib/shell/time-zone";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Crew > Shortages (B9, ADR 0148): one cross-event list of what is not covered yet, crew shifts and vendor labor alike,
 * computed at read time by app.crew_shortages. Rows run by day, in each shift's own time zone, then project, each linking
 * to its source. There is no map (S5-29 stays deferred). The range opens on the org's today plus 14 days, never a UTC
 * day, and the page has no header action: the empty state's is its one action, and only a planner sees it.
 */
export default async function Page({ params, searchParams }: PageProps<"/[org]/crew/shortages">) {
  const routeParams = await params;
  const search = flatParams(await searchParams);
  const node = "crew.shortages";
  const crew = await getCrewContext(node, routeParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = crew.ctx.viewer.db;
  const view = resolveView(node, search["view"]);
  const base = nodeHref(node, routeParams) ?? "/";
  // A table row opens its source: the shift, or the order a vendor line is on.
  const opened = /^(shift|po):([0-9a-f-]{36})/.exec(search["peek"] ?? "");
  if (opened) {
    redirect(
      opened[1] === "shift"
        ? (`/${crew.slug}/crew/shifts?peek=${opened[2]}` as Route)
        : (`/${crew.slug}/procurement/purchase-orders?peek=${opened[2]}` as Route),
    );
  }
  const zone = await getOrgTimeZone(crew.ctx);
  const today = todayIn(zone);
  const from = isIsoDate(search["from"]) ? search["from"] : today;
  const to = isIsoDate(search["to"]) ? search["to"] : addDays(from, 14);
  const kindFilter = SHORTAGE_KINDS.find((k) => k === search["kind"]);
  const [result, roles] = await Promise.all([
    listShortages(db, { orgId: crew.orgId, from, to }),
    getRoleTitles(crew.ctx),
  ]);
  const refused = !result.ok && result.error.kind === "refusal" ? result.error.rule : null;
  if (!result.ok && refused === null) {
    throw new Error(`Cannot list shortages: ${result.error.kind}`);
  }
  const all = result.ok ? result.data : [];
  const counts = shortageCounts(all);
  const rows = kindFilter ? all.filter((r) => r.kind === kindFilter) : all;

  const hrefOf = (r: Shortage): string =>
    r.shiftId
      ? `/${crew.slug}/crew/shifts?peek=${r.shiftId}`
      : `/${crew.slug}/procurement/purchase-orders?peek=${r.purchaseOrderId ?? ""}`;
  const roleName = (code: string | null) => (code === null ? "" : (roles.get(code)?.title ?? code));
  const title = (r: Shortage): string => {
    const what =
      r.kind === "vendor_unconfirmed"
        ? (r.partyName ?? t("crew.shortages.unnamedVendor"))
        : roleName(r.roleCode);
    return what === ""
      ? t(`crew.shortages.kinds.${r.kind}`)
      : t("crew.common.pair", { a: t(`crew.shortages.kinds.${r.kind}`), b: what });
  };
  const who = (r: Shortage): string => {
    if (r.kind === "open") {
      return r.detail
        ? t("crew.positions.unfilledTitle", { title: r.detail })
        : t("crew.shifts.open");
    }
    if (r.kind === "agency_unfilled") {
      return r.detail
        ? t("crew.positions.unfilledTitle", { title: r.detail })
        : t("crew.agency.slotLabel", { account: r.partyName ?? t("crew.agency.slotUnnamed") });
    }
    if (r.kind === "vendor_unconfirmed") {
      return t("crew.shortages.quantity", { count: r.quantity ?? 0, line: r.detail ?? "" });
    }
    return r.personName ?? t("crew.shortages.unnamedPerson");
  };
  const when = (r: Shortage): string =>
    format.dateTime(new Date(r.startsAt), {
      timeZone: r.timeZone,
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  const dayLabel = (day: string): string =>
    format.dateTime(new Date(`${day}T12:00:00Z`), {
      timeZone: "UTC",
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  // Each row's day is in its own zone; the rows arrive by start, so a day can reappear only if zones straddle it.
  const days = [...new Set(rows.map((r) => dayIn(r.startsAt, r.timeZone)))].sort();

  let body;
  if (refused !== null) {
    body = (
      <InlineAlert tone="warning" title={t("crew.shortages.rangeTitle")}>
        {t(`crew.refusals.${refused}`)}
      </InlineAlert>
    );
  } else if (rows.length === 0) {
    body = kindFilter ? (
      <EmptyStateLink
        icon="CircleCheck"
        sentence={t("crew.shortages.emptyFiltered")}
        actionLabel={t("crew.common.clearFilter")}
        href={withParams(base, search, { kind: null })}
      />
    ) : crew.can("crew.shift.write") ? (
      <EmptyStateLink
        icon="CircleCheck"
        sentence={t("crew.shortages.empty")}
        actionLabel={t("crew.shortages.plan")}
        href={`/${crew.slug}/crew/schedule`}
      />
    ) : (
      <p className="m-0 text-text-13 text-text-secondary">{t("crew.shortages.emptyReader")}</p>
    );
  } else if (view === "table") {
    body = (
      <PeekTable
        caption={t("crew.shortages.caption")}
        columns={[
          { key: "day", label: t("crew.shortages.day") },
          { key: "project", label: t("crew.fields.project") },
          { key: "what", label: t("crew.shortages.what") },
          { key: "who", label: t("crew.shortages.who"), wrap: true },
          { key: "when", label: t("crew.fields.when") },
          { key: "why", label: t("crew.shortages.why"), wrap: true },
        ]}
        rows={rows.map((r) => ({
          // Unique per row, since a shift can be short in two ways; the part before ":" names the source to open.
          id: r.shiftId
            ? `shift:${r.shiftId}:${r.kind}`
            : `po:${r.purchaseOrderId ?? ""}:${r.poLineId ?? ""}`,
          day: dayLabel(dayIn(r.startsAt, r.timeZone)),
          project: r.projectName,
          what: title(r),
          who: who(r),
          when: when(r),
          why: r.kind === "reconfirm_declined" || r.kind === "no_show" ? (r.detail ?? "") : "",
        }))}
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-16">
        {days.map((day) => {
          const inDay = rows.filter((r) => dayIn(r.startsAt, r.timeZone) === day);
          const projects = [...new Set(inDay.map((r) => r.projectId))];
          return (
            <section key={day} aria-labelledby={`shortages-${day}`} className="flex flex-col gap-8">
              <h2 id={`shortages-${day}`} className="m-0 text-text-13 font-semibold">
                {dayLabel(day)}
              </h2>
              {projects.map((projectId) => {
                const inProject = inDay.filter((r) => r.projectId === projectId);
                return (
                  <div key={projectId} className="flex flex-col gap-4">
                    <h3 className="m-0 text-text-12 font-medium text-text-secondary">
                      {inProject[0]?.projectName}
                    </h3>
                    <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0">
                      {inProject.map((r) => (
                        <li key={`${r.kind}:${r.shiftId ?? r.poLineId ?? ""}`}>
                          <Link
                            href={hrefOf(r) as Route}
                            className="flex flex-wrap items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
                          >
                            <span className="flex flex-col">
                              <span className="text-text-13 font-medium">{title(r)}</span>
                              <span className="text-text-12 text-text-secondary">
                                {t("crew.common.pair", { a: who(r), b: when(r) })}
                              </span>
                              {r.kind === "reconfirm_declined" || r.kind === "no_show" ? (
                                <span className="text-text-12 text-text-secondary">{r.detail}</span>
                              ) : null}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
    );
  }

  return (
    <CrewFrame
      crew={crew}
      node={node}
      module="crew"
      params={routeParams}
      search={search}
      count={rows.length}
      view={view}
      filters={
        <>
          <FilterDate name="from" label={t("crew.shortages.from")} value={from} />
          <FilterDate name="to" label={t("crew.shortages.to")} value={to} />
          <FilterSelect
            name="kind"
            label={t("crew.shortages.kind")}
            value={kindFilter ?? ""}
            options={[
              { value: "", label: t("crew.shortages.allKinds", { count: all.length }) },
              ...SHORTAGE_KINDS.map((k) => ({
                value: k,
                label: t("crew.shortages.kindCount", {
                  kind: t(`crew.shortages.kinds.${k}`),
                  count: counts.get(k) ?? 0,
                }),
              })),
            ]}
          />
        </>
      }
    >
      {body}
    </CrewFrame>
  );
}
