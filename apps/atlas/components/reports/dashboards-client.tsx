"use client";

import { Button, Checkbox, Input, Select } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import type { ActionState } from "@/app/[org]/finance/actions";
import {
  addTileAction,
  createDashboardAction,
  createScheduleAction,
} from "@/app/[org]/reports/dashboards/actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { ActionFeedback, type Option } from "@/components/finance/kit";

/**
 * Client forms of dashboards and scheduled report email (A43, finding A38-004; journey 29). Field
 * errors name keys under `reporting.errors`; refusals show through the shared ActionFeedback.
 */

const INITIAL: ActionState = {};

function useReportingT() {
  return useTranslations("reporting") as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
}

function fieldError(t: ReturnType<typeof useReportingT>, state: ActionState, name: string): string {
  return state.fieldErrors?.[name] ? t(`errors.${state.fieldErrors[name]}`) : "";
}

export function CreateDashboardForm({ org }: { org: string }) {
  const t = useReportingT();
  const [state, action, pending] = useActionState(createDashboardAction, INITIAL);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-wrap items-end gap-12"
      aria-label={t("dashboards.create")}
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <Input
        id="dashboard-name"
        name="name"
        required
        maxLength={100}
        label={t("dashboards.name")}
        placeholder={t("dashboards.nameHint")}
        error={fieldError(t, state, "name")}
      />
      <Button type="submit" variant="primary" loading={pending}>
        {t("dashboards.createSubmit")}
      </Button>
      <ActionFeedback state={state} success={t("dashboards.created")} />
    </form>
  );
}

export function AddTileForm({
  org,
  reportDefinitionId,
  dashboards,
}: {
  org: string;
  reportDefinitionId: string;
  dashboards: readonly Option[];
}) {
  const t = useReportingT();
  const [state, action, pending] = useActionState(addTileAction, INITIAL);
  return (
    <form
      action={action}
      className="flex flex-wrap items-end gap-12"
      aria-label={t("tile.title")}
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="reportDefinitionId" value={reportDefinitionId} />
      <Select
        id={`tile-dashboard-${reportDefinitionId}`}
        name="dashboardId"
        label={t("tile.dashboard")}
        placeholder={t("tile.chooseDashboard")}
        options={[...dashboards]}
        error={fieldError(t, state, "dashboardId")}
      />
      <Select
        id={`tile-width-${reportDefinitionId}`}
        name="columnSpan"
        label={t("tile.width")}
        value="6"
        options={["4", "6", "12"].map((w) => ({ value: w, label: t(`tile.widths.${w}`) }))}
      />
      <Button type="submit" loading={pending}>
        {t("tile.submit")}
      </Button>
      <ActionFeedback state={state} success={t("tile.added")} />
    </form>
  );
}

export function ScheduleForm({
  org,
  reportDefinitionId,
  members,
  timeZone,
}: {
  org: string;
  reportDefinitionId: string;
  members: readonly Option[];
  timeZone: string;
}) {
  const t = useReportingT();
  const [state, action, pending] = useActionState(createScheduleAction, INITIAL);
  const [cadence, setCadence] = useState("Weekly");
  const prefix = `schedule-${reportDefinitionId}`;
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      aria-label={t("schedule.title")}
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="reportDefinitionId" value={reportDefinitionId} />
      <div className="flex flex-wrap items-end gap-12">
        <Select
          id={`${prefix}-cadence`}
          name="cadence"
          label={t("schedule.cadence")}
          value={cadence}
          onChange={(e) => setCadence(e.target.value)}
          options={["Daily", "Weekly", "Monthly"].map((c) => ({
            value: c,
            label: t(`schedule.cadences.${c}`),
          }))}
        />
        {cadence === "Weekly" ? (
          <Select
            id={`${prefix}-weekday`}
            name="weekday"
            label={t("schedule.weekday")}
            value="1"
            options={["1", "2", "3", "4", "5", "6", "7"].map((d) => ({
              value: d,
              label: t(`schedule.weekdays.${d}`),
            }))}
            error={fieldError(t, state, "weekday")}
          />
        ) : null}
        {cadence === "Monthly" ? (
          <Input
            id={`${prefix}-month-day`}
            name="monthDay"
            type="number"
            min={1}
            max={28}
            defaultValue="1"
            label={t("schedule.monthDay")}
            help={t("schedule.monthDayHelp")}
            error={fieldError(t, state, "monthDay")}
            width={120}
          />
        ) : null}
        <Input
          id={`${prefix}-hour`}
          name="localHour"
          type="number"
          min={0}
          max={23}
          defaultValue="8"
          label={t("schedule.hour")}
          error={fieldError(t, state, "localHour")}
          width={96}
        />
        <Input
          id={`${prefix}-zone`}
          name="timeZone"
          defaultValue={timeZone}
          label={t("schedule.timeZone")}
          error={fieldError(t, state, "timeZone")}
        />
        <Select
          id={`${prefix}-format`}
          name="format"
          label={t("schedule.format")}
          value="PDF"
          options={["PDF", "CSV", "XLSX"].map((f) => ({ value: f, label: f }))}
        />
      </div>
      <fieldset className="m-0 flex flex-col gap-6 border-0 p-0">
        <legend className="mb-4 text-text-13 font-medium">{t("schedule.recipients")}</legend>
        <p className="m-0 text-text-12 text-text-secondary">{t("schedule.recipientsHelp")}</p>
        {members.map((m) => (
          <Checkbox key={m.value} name="recipients" value={m.value} label={m.label} />
        ))}
        {fieldError(t, state, "recipients") ? (
          <p role="alert" className="m-0 text-text-12 text-danger-text">
            {fieldError(t, state, "recipients")}
          </p>
        ) : null}
      </fieldset>
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {t("schedule.submit")}
        </Button>
      </div>
      <ActionFeedback state={state} success={t("schedule.scheduled")} />
    </form>
  );
}
