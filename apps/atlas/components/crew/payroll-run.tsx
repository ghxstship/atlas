import { getPayrollRun, personNames } from "@xos/data/crew";
import { getFormatter } from "next-intl/server";
import {
  approveRunAction,
  calculateRunAction,
  downloadExportAction,
  produceExportAction,
  transitionRunAction,
} from "@/app/[org]/crew/actions";
import type { CrewContext } from "@/lib/crew/context";
import { money } from "@/lib/crew/format";
import { stateIcon } from "@/lib/crew/states";
import { getTranslate } from "@/lib/shell/translate";
import { ConfirmButton, DownloadButton } from "./forms";
import { CrewRecord } from "./record";
import { InlineAlert } from "./ui";
import { PeekTable } from "./views";

/**
 * A payroll run in the one record anatomy, shared by Pay Periods and Payroll Exports: its lines with
 * NULL-aware totals (masked without data.restricted.read.payroll), and the moves its state allows.
 * Calculation, approval under spend authority and the export are database RPCs (migration 0461).
 */
export async function PayrollRunRecord(props: {
  crew: CrewContext;
  runId: string;
  mode: "peek" | "full";
  backHref: string;
  /** Whether the org's plan includes payroll_export (Team and up). */
  exportAllowed: boolean;
}) {
  const { crew } = props;
  const t = await getTranslate();
  const format = await getFormatter();
  const detail = await getPayrollRun(crew.ctx.viewer.db, props.runId);
  if (!detail.ok) {
    if (detail.error.kind === "not-found") return null;
    throw new Error(`Cannot read payroll run: ${detail.error.kind}`);
  }
  const run = detail.data;
  const creators = await personNames(crew.ctx.viewer.db, [run.createdBy]);
  const manage = crew.can("crew.pay_period.manage");
  const canExport = crew.can("crew.payroll.export");
  const hidden = { org: crew.slug, id: run.id };
  const move = (
    label: string,
    title: string,
    reason: string,
    expected: string,
    next: string,
    variant?: "primary" | "danger",
  ) => (
    <ConfirmButton
      label={label}
      title={title}
      defaultReason={reason}
      action={transitionRunAction}
      hidden={{ ...hidden, expected, next }}
      {...(variant ? { variant } : {})}
    />
  );
  const anyMasked = run.lines.some((l) => l.masked);
  return (
    <CrewRecord
      crew={crew}
      mode={props.mode}
      kindLabel={t("crew.kinds.payrollRun")}
      recordKey={run.currencyCode}
      title={t("crew.payroll.runTitle", {
        period: format.dateTimeRange(
          new Date(`${run.periodStartsOn}T12:00:00Z`),
          new Date(`${run.periodEndsOn}T12:00:00Z`),
          { timeZone: "UTC", dateStyle: "medium" },
        ),
      })}
      state={stateIcon("payrollRun", run.state)}
      stateLabel={t(`crew.states.payrollRun.${run.state}`)}
      stateName={(v) => t(`crew.states.payrollRun.${v}`)}
      history={run.transitions}
      backHref={props.backHref}
      actions={
        <>
          {manage && run.state === "Draft" ? (
            <ConfirmButton
              label={t("crew.payroll.calculate")}
              title={t("crew.payroll.calculateTitle")}
              description={t("crew.payroll.calculateHelp")}
              defaultReason={t("crew.payroll.calculateReason")}
              action={calculateRunAction}
              hidden={hidden}
              variant="primary"
            />
          ) : null}
          {manage && run.state === "Calculated" ? (
            <>
              <ConfirmButton
                label={t("crew.swapsPage.approve")}
                title={t("crew.payroll.approveTitle")}
                description={t("crew.payroll.approveHelp")}
                defaultReason={t("crew.payroll.approveReason")}
                action={approveRunAction}
                hidden={hidden}
                variant="primary"
              />
              {move(
                t("crew.payroll.toDraft"),
                t("crew.payroll.toDraftTitle"),
                t("crew.payroll.toDraftReason"),
                "Calculated",
                "Draft",
              )}
            </>
          ) : null}
          {canExport && run.state === "Approved" && props.exportAllowed ? (
            <DownloadButton
              label={t("crew.payroll.produce")}
              action={produceExportAction}
              hidden={hidden}
            />
          ) : null}
          {canExport && run.state === "Exported"
            ? move(
                t("crew.payroll.accepted"),
                t("crew.payroll.acceptedTitle"),
                t("crew.payroll.acceptedReason"),
                "Exported",
                "Accepted",
                "primary",
              )
            : null}
          {manage && ["Draft", "Calculated", "Approved"].includes(run.state)
            ? move(
                t("crew.payroll.cancel"),
                t("crew.payroll.cancelTitle"),
                t("crew.payroll.cancelReason"),
                run.state,
                "Canceled",
                "danger",
              )
            : null}
        </>
      }
      properties={[
        {
          label: t("crew.payroll.period"),
          value: t("crew.common.range", { start: run.periodStartsOn, end: run.periodEndsOn }),
        },
        { label: t("crew.rates.currency"), value: run.currencyCode },
        { label: t("crew.payroll.lines"), value: format.number(run.lines.length) },
        { label: t("crew.fields.hours"), value: format.number(run.totalHours) },
        {
          label: t("crew.payroll.total"),
          value: money(format, t, run.totalMinor, run.currencyCode, anyMasked),
        },
        {
          label: t("crew.payroll.createdBy"),
          value:
            (run.createdBy && creators.ok ? creators.data.get(run.createdBy) : null) ??
            t("crew.record.someone"),
        },
      ]}
    >
      {run.state === "Approved" && canExport && !props.exportAllowed ? (
        <InlineAlert tone="warning" title={t("crew.payroll.planTitle")}>
          {t("crew.refusals.plan_feature_required")}
        </InlineAlert>
      ) : null}
      {anyMasked ? (
        <InlineAlert tone="info" title={t("crew.rates.maskedTitle")}>
          {t("crew.payroll.maskedBody")}
        </InlineAlert>
      ) : null}
      {run.lines.length > 0 ? (
        <PeekTable
          caption={t("crew.payroll.lines")}
          activatable={false}
          columns={[
            { key: "person", label: t("crew.fields.person") },
            { key: "code", label: t("crew.payroll.earningCode"), type: "code" },
            { key: "hours", label: t("crew.fields.hours"), type: "number" },
            { key: "rate", label: t("crew.rates.rate") },
            { key: "amount", label: t("crew.payroll.amount") },
          ]}
          rows={run.lines.map((l) => ({
            id: l.id,
            person: l.member.name ?? t("crew.common.unnamed"),
            code: l.earningCode,
            hours: l.hours,
            rate: money(format, t, l.rateMinor, run.currencyCode, l.masked),
            amount: money(format, t, l.amountMinor, run.currencyCode, l.masked),
          }))}
        />
      ) : (
        <p className="m-0 text-text-12 text-text-secondary">
          {run.state === "Draft" ? t("crew.payroll.noLinesDraft") : t("crew.payroll.noLines")}
        </p>
      )}
      {run.exports.length > 0 ? (
        <section aria-labelledby="run-exports" className="flex flex-col gap-8">
          <h2 id="run-exports" className="m-0 text-text-13 font-semibold">
            {t("crew.payroll.exports")}
          </h2>
          <ul className="m-0 flex list-none flex-col gap-8 p-0">
            {run.exports.map((x) => (
              <li
                key={x.id}
                className="flex flex-col gap-4 rounded-card border border-border-subtle p-8 text-text-12"
              >
                <span>
                  {t("crew.payroll.exportLine", {
                    provider: x.provider,
                    at: format.dateTime(new Date(x.createdAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })}
                </span>
                <span className="break-all font-mono text-text-11 text-text-secondary">
                  {x.checksum}
                </span>
                {canExport && props.exportAllowed ? (
                  <DownloadButton
                    label={t("crew.payroll.download")}
                    action={downloadExportAction}
                    hidden={{ org: crew.slug, id: x.id }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </CrewRecord>
  );
}
