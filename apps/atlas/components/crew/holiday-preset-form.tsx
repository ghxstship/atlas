"use client";

import { Button, InlineAlert, Select } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { Feedback } from "@/components/platform/kit";
import { INITIAL_PLATFORM_STATE } from "@/lib/platform/state";
import { holidayPresetAction } from "@/components/settings/contributions/a134-actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * "Add US federal holidays for [year]" on a holiday calendar (P8, 2854): the eleven holidays of
 * 5 U.S.C. 6103 on their observed days, each paying 8 hours, named in the viewer's language. Days
 * the calendar already holds are skipped, and the result says how many were added and how many it
 * already held. The form says that each added holiday pays 8 hours and that payroll needs a holiday
 * earning code.
 */
export function HolidayPresetForm({
  org,
  calendarId,
  calendarName,
  thisYear,
}: {
  org: string;
  calendarId: string;
  calendarName: string;
  thisYear: number;
}) {
  const t = useTranslations("crew.payrollSettings.holidays.preset") as unknown as Translate;
  const [state, action, pending] = useActionState(holidayPresetAction, INITIAL_PLATFORM_STATE);
  const years = [thisYear, thisYear + 1, thisYear + 2].filter((y) => y >= 2021 && y <= 2100);
  const [added, total] = (state.ok && state.value ? state.value.split(":") : []).map(Number);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      aria-label={t("label", { name: calendarName })}
      className="flex flex-col gap-8"
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="calendar" value={calendarId} />
      <div className="flex flex-wrap items-end gap-8">
        <Select
          id={`preset-${calendarId}-year`}
          name="year"
          label={t("year")}
          value={String(years[0] ?? thisYear)}
          options={years.map((y) => ({ value: String(y), label: String(y) }))}
        />
        <Button type="submit" variant="secondary" loading={pending}>
          {t("button")}
        </Button>
      </div>
      <p className="m-0 text-text-12 text-text-secondary">{t("help")}</p>
      <div aria-live="polite">
        {state.ok && added !== undefined && total !== undefined ? (
          <InlineAlert tone="success">
            {t("result", { added, existing: Math.max(0, total - added) })}
          </InlineAlert>
        ) : (
          <Feedback state={state} />
        )}
      </div>
    </form>
  );
}
