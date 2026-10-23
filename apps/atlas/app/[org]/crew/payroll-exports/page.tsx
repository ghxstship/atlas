import { listPayrollExports, listPayrollRuns } from "@xos/data/crew";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import { CrewFrame, resolveView } from "@/components/crew/frame";
import { PayrollRunRecord } from "@/components/crew/payroll-run";
import { RefusalNotice } from "@/components/crew/ui";
import { PeekTable } from "@/components/crew/views-peek-table";
import { collectionPeek } from "@/components/shell/collection-peek";
import { EmptyStateLink } from "@/components/ui";
import { flatParams, getCrewContext, withParams } from "@/lib/crew/context";
import { planHasFeature } from "@/lib/crew/plan";
import { stateIcon } from "@/lib/crew/states";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Crew > Payroll Exports (Section 4.5.5, Section 16): approved runs ready to export and every export
 * produced, with its checksum. The payroll_export feature starts at the Team plan; below it the page
 * explains the upgrade instead of offering the export, and SQL refuses it anyway (migration 0461).
 * A19's payroll handoffs (Gusto, ADP, Rippling) consume the produced file.
 */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/crew/payroll-exports">) {
  const routeParams = await params;
  const search = flatParams(await searchParams);
  const node = "crew.payroll-exports";
  const crew = await getCrewContext(node, routeParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = crew.ctx.viewer.db;
  const view = resolveView(node, search["view"]);
  const base = nodeHref(node, routeParams) ?? "/";
  const exportAllowed = await planHasFeature(crew.ctx, "payroll_export");
  const [exportsResult, readyResult] = await Promise.all([
    listPayrollExports(db, crew.orgId),
    listPayrollRuns(db, { orgId: crew.orgId, states: ["Approved"] }),
  ]);
  if (!exportsResult.ok)
    throw new Error(`Cannot list payroll exports: ${exportsResult.error.kind}`);
  if (!readyResult.ok) throw new Error(`Cannot list payroll runs: ${readyResult.error.kind}`);
  const exportsList = exportsResult.data;
  const ready = readyResult.data;
  const back = withParams(base, search, { peek: null, full: null });
  const range = (a: string, b: string) =>
    a && b
      ? format.dateTimeRange(new Date(`${a}T12:00:00Z`), new Date(`${b}T12:00:00Z`), {
          timeZone: "UTC",
          dateStyle: "medium",
        })
      : "";

  let peek = null;
  if (search["peek"]) {
    peek = await PayrollRunRecord({
      crew,
      runId: search["peek"],
      mode: search["full"] === "1" ? "full" : "peek",
      backHref: back,
      exportAllowed,
    });
    if (search["full"] === "1" && peek) return peek;
  }

  return (
    <CrewFrame
      crew={crew}
      node={node}
      module="crew"
      params={routeParams}
      search={search}
      count={exportsList.length}
      view={view}
      peek={collectionPeek(search["peek"], peek)}
    >
      {!exportAllowed ? (
        <RefusalNotice
          outcome="REFUSE"
          title={t("crew.payroll.planTitle")}
          reason={t("crew.refusals.plan_feature_required")}
        />
      ) : null}
      {exportAllowed && ready.length > 0 ? (
        <section aria-labelledby="ready-runs" className="flex flex-col gap-8">
          <h2 id="ready-runs" className="m-0 text-heading-16 font-semibold">
            {t("crew.payroll.ready")}
          </h2>
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {ready.map((r) => (
              <li key={r.id}>
                <Link
                  href={withParams(base, search, { peek: r.id }) as Route}
                  className="flex items-center justify-between gap-8 rounded-card border border-border-subtle px-12 py-8 hover:bg-bg-hover"
                >
                  <span className="text-text-13">
                    {t("crew.payroll.runTitle", {
                      period: range(r.periodStartsOn, r.periodEndsOn),
                    })}
                  </span>
                  <span className="text-text-12 text-text-secondary">
                    {t("crew.payroll.readyHint")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {exportsList.length === 0 ? (
        <EmptyStateLink
          icon="FileOutput"
          sentence={exportAllowed ? t("crew.payroll.noExports") : t("crew.payroll.noExportsPlan")}
          actionLabel={exportAllowed ? t("crew.payroll.goPeriods") : t("crew.payroll.seePlans")}
          href={
            exportAllowed
              ? `/${crew.slug}/crew/pay-periods`
              : `/${crew.slug}/settings/billing-and-plan`
          }
        />
      ) : view === "list" ? (
        <ul
          aria-label={t("crew.payroll.exports")}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
        >
          {exportsList.map((x) => (
            <li key={x.id}>
              <Link
                href={withParams(base, search, { peek: x.payrollRunId }) as Route}
                className="flex items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
              >
                <span className="flex flex-col">
                  <span className="text-text-13 font-medium">
                    {t("crew.payroll.exportLine", {
                      provider: x.provider,
                      at: format.dateTime(new Date(x.createdAt), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }),
                    })}
                  </span>
                  <span className="text-text-12 text-text-secondary">
                    {x.run ? range(x.run.periodStartsOn, x.run.periodEndsOn) : ""}
                  </span>
                </span>
                <span className="text-text-12 text-text-secondary">
                  {x.run ? t(`crew.states.payrollRun.${x.run.state}`) : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <PeekTable
          caption={t("crew.payroll.exports")}
          columns={[
            { key: "at", label: t("crew.payroll.exportedAt") },
            { key: "period", label: t("crew.payroll.period") },
            { key: "provider", label: t("crew.payroll.provider") },
            { key: "checksum", label: t("crew.payroll.checksum"), type: "code" },
            { key: "state", label: t("crew.fields.state"), type: "state" },
          ]}
          rows={exportsList.map((x) => ({
            id: x.payrollRunId,
            at: format.dateTime(new Date(x.createdAt), { dateStyle: "medium", timeStyle: "short" }),
            period: x.run ? range(x.run.periodStartsOn, x.run.periodEndsOn) : "",
            provider: x.provider,
            checksum: x.checksum.slice(0, 12),
            state: x.run
              ? {
                  state: stateIcon("payrollRun", x.run.state),
                  label: t(`crew.states.payrollRun.${x.run.state}`),
                }
              : null,
          }))}
        />
      )}
    </CrewFrame>
  );
}
