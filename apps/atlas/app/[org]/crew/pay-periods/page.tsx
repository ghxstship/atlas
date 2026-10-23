import { getPayPeriod, listCurrencies, listPayPeriods, PAY_PERIOD_STATES } from "@xos/data/crew";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import {
  createPayPeriodAction,
  createPayrollRunAction,
  transitionPayPeriodAction,
  updatePayPeriodAction,
} from "@/app/[org]/crew/actions";
import { ConfirmButton } from "@/components/crew/forms-confirm-button";
import { DrawerForm } from "@/components/crew/forms-drawer-form";
import { CrewFrame, resolveView } from "@/components/crew/frame";
import { PayrollRunRecord } from "@/components/crew/payroll-run";
import { CrewRecord } from "@/components/crew/record";
import { FilterSelect } from "@/components/crew/views-filter-select";
import { PeekTable } from "@/components/crew/views-peek-table";
import { collectionPeek } from "@/components/shell/collection-peek";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import { flatParams, getCrewContext, withParams } from "@/lib/crew/context";
import { planHasFeature } from "@/lib/crew/plan";
import { stateIcon } from "@/lib/crew/states";
import { nextPayPeriodDates } from "@xos/data/crew";
import { peekRowMissing } from "@/lib/shell/peek-handoff";
import { nodeHref } from "@/lib/shell/sitemap";
import { orgToday } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Crew > Pay Periods (Section 4.5.5): the periods payroll runs on, Open, Closed and Posted (a posted
 * period never reopens, invariant 14), and their payroll runs, which move from Draft to Accepted only
 * through Calculated, Approved and Exported (invariant 15). Runs open in the side peek as `run:<id>`.
 */
export default async function Page({ params, searchParams }: PageProps<"/[org]/crew/pay-periods">) {
  const routeParams = await params;
  const search = flatParams(await searchParams);
  const node = "crew.pay-periods";
  const crew = await getCrewContext(node, routeParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = crew.ctx.viewer.db;
  const view = resolveView(node, search["view"]);
  const base = nodeHref(node, routeParams) ?? "/";
  const result = await listPayPeriods(db, crew.orgId);
  if (!result.ok) throw new Error(`Cannot list pay periods: ${result.error.kind}`);
  const stateFilter = PAY_PERIOD_STATES.find((s) => s === search["state"]);
  const periods = result.data.filter((p) => !stateFilter || p.state === stateFilter);
  const manage = crew.can("crew.pay_period.manage");
  const exportAllowed = await planHasFeature(crew.ctx, "payroll_export");
  const range = (a: string, b: string) =>
    format.dateTimeRange(new Date(`${a}T12:00:00Z`), new Date(`${b}T12:00:00Z`), {
      timeZone: "UTC",
      dateStyle: "medium",
    });
  const back = withParams(base, search, { peek: null, full: null });

  let peek = null;
  const peekId = search["peek"];
  if (peekId?.startsWith("run:")) {
    peek = await PayrollRunRecord({
      crew,
      runId: peekId.slice(4),
      mode: search["full"] === "1" ? "full" : "peek",
      backHref: back,
      exportAllowed,
    });
    if (search["full"] === "1" && peek) return peek;
  } else if (peekId) {
    const detail = await getPayPeriod(db, peekId);
    if (detail.ok) {
      const p = detail.data;
      const hidden = { org: crew.slug, id: p.id };
      const record = (
        <CrewRecord
          crew={crew}
          mode={search["full"] === "1" ? "full" : "peek"}
          subject={{ table: "app.pay_periods", id: p.id }}
          kindLabel={t("crew.kinds.payPeriod")}
          recordKey={p.startsOn}
          title={range(p.startsOn, p.endsOn)}
          state={stateIcon("payPeriod", p.state)}
          stateLabel={t(`crew.states.payPeriod.${p.state}`)}
          stateName={(v) => t(`crew.states.payPeriod.${v}`)}
          history={p.transitions}
          backHref={back}
          actions={
            manage ? (
              <>
                {p.state === "Open" ? (
                  <>
                    <ButtonLink
                      href={withParams(base, search, { run: p.id })}
                      size="sm"
                      variant="primary"
                    >
                      {t("crew.payroll.newRun")}
                    </ButtonLink>
                    <ButtonLink
                      href={withParams(base, search, { peek: null, edit: p.id })}
                      size="sm"
                    >
                      {t("crew.common.edit")}
                    </ButtonLink>
                    <ConfirmButton
                      label={t("crew.payroll.close")}
                      title={t("crew.payroll.closeTitle")}
                      defaultReason={t("crew.payroll.closeReason")}
                      action={transitionPayPeriodAction}
                      hidden={{ ...hidden, expected: "Open", next: "Closed" }}
                    />
                  </>
                ) : null}
                {p.state === "Closed" ? (
                  <>
                    <ConfirmButton
                      label={t("crew.payroll.post")}
                      title={t("crew.payroll.postTitle")}
                      description={t("crew.payroll.postHelp")}
                      defaultReason={t("crew.payroll.postReason")}
                      action={transitionPayPeriodAction}
                      hidden={{ ...hidden, expected: "Closed", next: "Posted" }}
                      variant="primary"
                    />
                    <ConfirmButton
                      label={t("crew.payroll.reopen")}
                      title={t("crew.payroll.reopenTitle")}
                      defaultReason={t("crew.payroll.reopenReason")}
                      action={transitionPayPeriodAction}
                      hidden={{ ...hidden, expected: "Closed", next: "Open" }}
                    />
                  </>
                ) : null}
              </>
            ) : null
          }
          properties={[
            { label: t("crew.payroll.firstDay"), value: p.startsOn },
            { label: t("crew.payroll.lastDay"), value: p.endsOn },
            { label: t("crew.payroll.runs"), value: format.number(p.runCount) },
          ]}
        >
          <section aria-labelledby="period-runs" className="flex flex-col gap-8">
            <h2 id="period-runs" className="m-0 text-text-13 font-semibold">
              {t("crew.payroll.runs")}
            </h2>
            {p.runs.length === 0 ? (
              <p className="m-0 text-text-12 text-text-secondary">
                {p.state === "Open" ? t("crew.payroll.noRunsOpen") : t("crew.payroll.noRuns")}
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-4 p-0">
                {p.runs.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={withParams(base, search, { peek: `run:${r.id}` }) as Route}
                      className="flex items-center justify-between gap-8 rounded-card border border-border-subtle px-8 py-6 text-text-12 hover:bg-bg-hover"
                    >
                      <span>
                        {t("crew.payroll.runLine", {
                          currency: r.currencyCode,
                          at: format.dateTime(new Date(r.createdAt), { dateStyle: "medium" }),
                        })}
                      </span>
                      <span className="text-text-secondary">
                        {t(`crew.states.payrollRun.${r.state}`)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </CrewRecord>
      );
      if (search["full"] === "1") return record;
      peek = record;
    } else if (!peekRowMissing(detail.error)) {
      throw new Error(`Cannot read pay period: ${detail.error.kind}`);
    }
  }

  // Drawers: a new period proposed from the payroll settings (payroll.pay_period and payroll.week_start,
  // migration 1323) after the latest one, edits while Open, and new runs. A first period starts in the
  // org's week on its calendar (A71), never UTC's.
  const proposed =
    search["create"] === "1" && manage
      ? await nextPayPeriodDates(db, crew.orgId, await orgToday(crew.ctx))
      : null;
  if (proposed && !proposed.ok)
    throw new Error(`Cannot propose a pay period: ${proposed.error.kind}`);
  const editing = search["edit"] ? result.data.find((p) => p.id === search["edit"]) : undefined;
  const runFor = search["run"] ? result.data.find((p) => p.id === search["run"]) : undefined;
  const currencies = runFor ? await listCurrencies(db) : null;
  let drawer = null;
  if (search["create"] === "1" && manage) {
    drawer = (
      <DrawerForm
        title={t("crew.payroll.createTitle")}
        submitLabel={t("crew.payroll.create")}
        action={createPayPeriodAction}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          {
            kind: "date",
            name: "startsOn",
            label: t("crew.payroll.firstDay"),
            value: proposed?.ok ? proposed.data.startsOn : "",
            required: true,
          },
          {
            kind: "date",
            name: "endsOn",
            label: t("crew.payroll.lastDay"),
            value: proposed?.ok ? proposed.data.endsOn : "",
            required: true,
            help: t("crew.payroll.periodHelp"),
          },
        ]}
      />
    );
  } else if (editing && manage) {
    drawer = (
      <DrawerForm
        title={t("crew.payroll.editTitle")}
        submitLabel={t("crew.common.save")}
        action={updatePayPeriodAction}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          { kind: "hidden", name: "id", value: editing.id },
          {
            kind: "date",
            name: "startsOn",
            label: t("crew.payroll.firstDay"),
            value: editing.startsOn,
            required: true,
          },
          {
            kind: "date",
            name: "endsOn",
            label: t("crew.payroll.lastDay"),
            value: editing.endsOn,
            required: true,
          },
        ]}
      />
    );
  } else if (runFor && manage) {
    drawer = (
      <DrawerForm
        title={t("crew.payroll.newRun")}
        submitLabel={t("crew.payroll.newRun")}
        action={createPayrollRunAction}
        openKeys={["run"]}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          { kind: "hidden", name: "payPeriodId", value: runFor.id },
          {
            kind: "select",
            name: "currencyCode",
            label: t("crew.rates.currency"),
            value: "USD",
            options: (currencies?.ok ? currencies.data : ["USD"]).map((c) => ({
              value: c,
              label: c,
            })),
          },
        ]}
      />
    );
  }

  let body;
  if (periods.length === 0) {
    body = (
      <EmptyStateLink
        icon="CalendarRange"
        sentence={
          stateFilter
            ? t("crew.swapsPage.emptyFiltered")
            : manage
              ? t("crew.payroll.emptyWriter")
              : t("crew.payroll.emptyReader")
        }
        actionLabel={
          stateFilter
            ? t("crew.common.clearFilter")
            : manage
              ? t("crew.payroll.create")
              : t("crew.sheets.viewEntries")
        }
        href={
          stateFilter
            ? withParams(base, search, { state: null })
            : manage
              ? withParams(base, search, { create: "1" })
              : `/${crew.slug}/crew/timesheets`
        }
      />
    );
  } else if (view === "list") {
    body = (
      <ul
        aria-label={t("crew.payroll.periods")}
        className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
      >
        {periods.map((p) => (
          <li key={p.id}>
            <Link
              href={withParams(base, search, { peek: p.id }) as Route}
              className="flex items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
            >
              <span className="text-text-13 font-medium">{range(p.startsOn, p.endsOn)}</span>
              <span className="text-text-12 text-text-secondary">
                {t(`crew.states.payPeriod.${p.state}`)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <PeekTable
        caption={t("crew.payroll.periods")}
        columns={[
          { key: "period", label: t("crew.payroll.period") },
          { key: "runs", label: t("crew.payroll.runs"), type: "number" },
          { key: "state", label: t("crew.fields.state"), type: "state" },
        ]}
        rows={periods.map((p) => ({
          id: p.id,
          period: range(p.startsOn, p.endsOn),
          runs: p.runCount,
          state: {
            state: stateIcon("payPeriod", p.state),
            label: t(`crew.states.payPeriod.${p.state}`),
          },
        }))}
      />
    );
  }

  return (
    <CrewFrame
      crew={crew}
      node={node}
      module="crew"
      params={routeParams}
      search={search}
      count={periods.length}
      view={view}
      {...(manage
        ? {
            actions: (
              <ButtonLink
                href={withParams(base, search, { create: "1" })}
                variant="primary"
                size="sm"
              >
                {t("crew.payroll.create")}
              </ButtonLink>
            ),
          }
        : {})}
      filters={
        <FilterSelect
          name="state"
          label={t("crew.fields.state")}
          value={stateFilter ?? ""}
          options={[
            { value: "", label: t("crew.common.allStates") },
            ...PAY_PERIOD_STATES.map((v) => ({ value: v, label: t(`crew.states.payPeriod.${v}`) })),
          ]}
        />
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
