import {
  listEarningCodes,
  listHolidayCalendars,
  listTimeOffPolicies,
  type EarningCode,
  type EarningCodeKind,
  type HolidayCalendar,
} from "@xos/data/crew";
import { listVenues } from "@xos/data/projects";
import { getFormatter } from "next-intl/server";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/platform/kit";
import { Checkbox, InlineAlert, Input, Select } from "@/components/ui";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import {
  earningCodeAction,
  holidayAction,
  holidayCalendarAction,
  holidayVenueAction,
  timeOffPolicyAction,
} from "./a134-actions";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A134's panels on Settings, Payroll and Time Off (RRR-196, Section 4.5.6, ADR 0112):
 *   Earning codes        the codes payroll lines are paid under, each regular, overtime or holiday; create, edit, retire
 *   Time off policies    what Crew, Time Off requests are made under, with their accrual; create, edit, retire
 *   Holiday calendars    org and venue calendars, optionally for one subdivision, and their dated holidays; a holiday
 *                        takes its day out of time off day counts and pays its hours in payroll runs
 * Everyone in the org reads them; forms appear with org.payroll.write, and row level security decides each write
 * (migrations 0341 and 2270). Each form is the platform ActionForm, which keeps typed input after a refusal and names
 * a taken code, name or day from `platform.refusals`; edit forms sit in closed disclosures.
 */

const P = "crew.payrollSettings";

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-12">
      <header className="flex flex-col gap-4">
        <h2 id={id} className="m-0 text-heading-16 font-semibold">
          {title}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">{description}</p>
      </header>
      {children}
    </section>
  );
}

/** A disclosure holding a row's edit form, closed until opened. */
function Edit({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="w-full">
      <summary className="cursor-pointer text-text-13 text-accent-text">{summary}</summary>
      <div className="pt-8">{children}</div>
    </details>
  );
}

const ROW = "flex flex-col gap-8 rounded-card border border-border-subtle p-12";

function kindOf(code: EarningCode): EarningCodeKind {
  return code.isHoliday ? "holiday" : code.isOvertime ? "overtime" : "regular";
}

function kindOptions(t: Translate) {
  return (["regular", "overtime", "holiday"] as const).map((k) => ({
    value: k,
    label: t(`${P}.earningCodes.kinds.${k}`),
  }));
}

function EarningCodeFields({
  t,
  idPrefix,
  code,
}: {
  t: Translate;
  idPrefix: string;
  code?: EarningCode;
}) {
  return (
    <div className="flex flex-wrap items-end gap-12">
      <Input
        id={`${idPrefix}-code`}
        name="code"
        label={t(`${P}.earningCodes.code`)}
        help={t(`${P}.earningCodes.codeHelp`)}
        defaultValue={code?.code ?? ""}
        maxLength={20}
        required
        width={160}
      />
      <Input
        id={`${idPrefix}-name`}
        name="name"
        label={t(`${P}.earningCodes.name`)}
        defaultValue={code?.name ?? ""}
        maxLength={100}
        required
      />
      <Select
        id={`${idPrefix}-kind`}
        name="kind"
        label={t(`${P}.earningCodes.kind`)}
        value={code ? kindOf(code) : "regular"}
        options={kindOptions(t)}
      />
    </div>
  );
}

// Earning codes -----------------------------------------------------------------------------------------------------------

async function EarningCodesPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const canEdit = ctx.capabilities.has("org.payroll.write");
  const codes = await listEarningCodes(ctx.viewer.db, ctx.org.id);
  const org = ctx.org.slug;
  return (
    <Section
      id="earning-codes"
      title={t(`${P}.earningCodes.title`)}
      description={t(`${P}.earningCodes.description`)}
    >
      {!codes.ok ? (
        <InlineAlert tone="danger">{t(`${P}.loadFailed`)}</InlineAlert>
      ) : codes.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.earningCodes.empty`)}</p>
      ) : (
        <ul
          aria-label={t(`${P}.earningCodes.title`)}
          className="m-0 flex list-none flex-col gap-8 p-0"
        >
          {codes.data.map((c) => (
            <li key={c.id} className={ROW}>
              <div className="flex flex-wrap items-baseline justify-between gap-8">
                <span className="text-text-14 font-semibold">
                  {t(`${P}.earningCodes.line`, { code: c.code, name: c.name })}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {t(`${P}.earningCodes.kinds.${kindOf(c)}`)}
                </span>
              </div>
              {canEdit ? (
                <div className="flex flex-wrap items-start gap-16">
                  <Edit summary={t(`${P}.earningCodes.edit`, { code: c.code })}>
                    <ActionForm
                      action={earningCodeAction}
                      hidden={{ org, intent: "update", id: c.id }}
                      label={t(`${P}.earningCodes.edit`, { code: c.code })}
                      submitLabel={t(`${P}.save`)}
                      submitVariant="secondary"
                      success={t(`${P}.saved`)}
                    >
                      <EarningCodeFields t={t} idPrefix={`code-${c.id}`} code={c} />
                    </ActionForm>
                  </Edit>
                  <ActionForm
                    action={earningCodeAction}
                    hidden={{ org, intent: "retire", id: c.id }}
                    label={t(`${P}.earningCodes.retire`, { code: c.code })}
                    submitLabel={t(`${P}.earningCodes.retire`, { code: c.code })}
                    submitVariant="ghost"
                    inline
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="flex flex-col gap-8">
          <h3 className="m-0 text-text-14 font-semibold">{t(`${P}.earningCodes.addTitle`)}</h3>
          <ActionForm
            action={earningCodeAction}
            hidden={{ org, intent: "create" }}
            label={t(`${P}.earningCodes.addTitle`)}
            submitLabel={t(`${P}.earningCodes.add`)}
            success={t(`${P}.added`)}
          >
            <EarningCodeFields t={t} idPrefix="code-new" />
          </ActionForm>
        </div>
      ) : (
        <p className="m-0 text-text-12 text-text-secondary">{t(`${P}.readOnly`)}</p>
      )}
    </Section>
  );
}

// Time off policies ---------------------------------------------------------------------------------------------------------

function PolicyFields({
  t,
  idPrefix,
  name,
  accrual,
}: {
  t: Translate;
  idPrefix: string;
  name?: string;
  accrual?: number | null;
}) {
  return (
    <div className="flex flex-wrap items-end gap-12">
      <Input
        id={`${idPrefix}-name`}
        name="name"
        label={t(`${P}.policies.name`)}
        defaultValue={name ?? ""}
        maxLength={100}
        required
      />
      <Input
        id={`${idPrefix}-accrual`}
        name="accrual"
        type="number"
        min={0}
        max={1000}
        step={0.25}
        label={t(`${P}.policies.accrual`)}
        help={t(`${P}.policies.accrualHelp`)}
        defaultValue={accrual === null || accrual === undefined ? "" : String(accrual)}
        width={200}
      />
    </div>
  );
}

async function TimeOffPoliciesPanel({ ctx }: SettingsPanelProps) {
  const [t, format] = await Promise.all([getTranslate(), getFormatter()]);
  const canEdit = ctx.capabilities.has("org.payroll.write");
  const policies = await listTimeOffPolicies(ctx.viewer.db, ctx.org.id);
  const org = ctx.org.slug;
  return (
    <Section
      id="time-off-policies"
      title={t(`${P}.policies.title`)}
      description={t(`${P}.policies.description`)}
    >
      {!policies.ok ? (
        <InlineAlert tone="danger">{t(`${P}.loadFailed`)}</InlineAlert>
      ) : policies.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.policies.empty`)}</p>
      ) : (
        <ul aria-label={t(`${P}.policies.title`)} className="m-0 flex list-none flex-col gap-8 p-0">
          {policies.data.map((p) => (
            <li key={p.id} className={ROW}>
              <div className="flex flex-wrap items-baseline justify-between gap-8">
                <span className="text-text-14 font-semibold">{p.name}</span>
                <span className="text-text-12 text-text-secondary">
                  {p.accrualHoursPerPeriod === null
                    ? t(`${P}.policies.noAccrual`)
                    : t(`${P}.policies.accrues`, { hours: format.number(p.accrualHoursPerPeriod) })}
                </span>
              </div>
              {canEdit ? (
                <div className="flex flex-wrap items-start gap-16">
                  <Edit summary={t(`${P}.policies.edit`, { name: p.name })}>
                    <ActionForm
                      action={timeOffPolicyAction}
                      hidden={{ org, intent: "update", id: p.id }}
                      label={t(`${P}.policies.edit`, { name: p.name })}
                      submitLabel={t(`${P}.save`)}
                      submitVariant="secondary"
                      success={t(`${P}.saved`)}
                    >
                      <PolicyFields
                        t={t}
                        idPrefix={`policy-${p.id}`}
                        name={p.name}
                        accrual={p.accrualHoursPerPeriod}
                      />
                    </ActionForm>
                  </Edit>
                  <ActionForm
                    action={timeOffPolicyAction}
                    hidden={{ org, intent: "retire", id: p.id }}
                    label={t(`${P}.policies.retire`, { name: p.name })}
                    submitLabel={t(`${P}.policies.retire`, { name: p.name })}
                    submitVariant="ghost"
                    inline
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="flex flex-col gap-8">
          <h3 className="m-0 text-text-14 font-semibold">{t(`${P}.policies.addTitle`)}</h3>
          <ActionForm
            action={timeOffPolicyAction}
            hidden={{ org, intent: "create" }}
            label={t(`${P}.policies.addTitle`)}
            submitLabel={t(`${P}.policies.add`)}
            success={t(`${P}.added`)}
          >
            <PolicyFields t={t} idPrefix="policy-new" />
          </ActionForm>
        </div>
      ) : null}
    </Section>
  );
}

// Holiday calendars ---------------------------------------------------------------------------------------------------------

function CalendarFields({
  t,
  idPrefix,
  calendar,
}: {
  t: Translate;
  idPrefix: string;
  calendar?: HolidayCalendar;
}) {
  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-wrap items-end gap-12">
        <Input
          id={`${idPrefix}-name`}
          name="name"
          label={t(`${P}.holidays.calendarName`)}
          defaultValue={calendar?.name ?? ""}
          maxLength={100}
          required
        />
        <Input
          id={`${idPrefix}-subdivision`}
          name="subdivision"
          label={t(`${P}.holidays.subdivision`)}
          help={t(`${P}.holidays.subdivisionHelp`)}
          defaultValue={calendar?.subdivisionCode ?? ""}
          maxLength={6}
          width={200}
        />
      </div>
      <Checkbox
        id={`${idPrefix}-applies`}
        name="appliesToOrg"
        label={t(`${P}.holidays.appliesToOrg`)}
        defaultChecked={calendar?.appliesToOrg ?? false}
      />
    </div>
  );
}

function scopeOf(t: Translate, c: HolidayCalendar): string {
  const parts: string[] = [];
  if (c.appliesToOrg) {
    parts.push(
      c.subdivisionCode
        ? t(`${P}.holidays.scopeSubdivision`, { code: c.subdivisionCode })
        : t(`${P}.holidays.scopeOrg`),
    );
  }
  if (c.venues.length > 0) {
    parts.push(t(`${P}.holidays.scopeVenues`, { venues: c.venues.map((v) => v.name).join(", ") }));
  }
  return parts.length > 0 ? parts.join(" ") : t(`${P}.holidays.scopeNone`);
}

async function HolidayCalendarsPanel({ ctx }: SettingsPanelProps) {
  const [t, format] = await Promise.all([getTranslate(), getFormatter()]);
  const canEdit = ctx.capabilities.has("org.payroll.write");
  const [calendars, venues] = await Promise.all([
    listHolidayCalendars(ctx.viewer.db, ctx.org.id),
    canEdit ? listVenues(ctx.viewer.db, ctx.org.id) : null,
  ]);
  const org = ctx.org.slug;
  // A venue has one calendar, so a venue already assigned is not offered again.
  const assigned = new Set(
    calendars.ok ? calendars.data.flatMap((c) => c.venues.map((v) => v.venueId)) : [],
  );
  const free = venues?.ok ? venues.data.filter((v) => !assigned.has(v.id)) : [];
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T12:00:00Z`), { timeZone: "UTC", dateStyle: "medium" });
  return (
    <Section
      id="holiday-calendars"
      title={t(`${P}.holidays.title`)}
      description={t(`${P}.holidays.description`)}
    >
      {!calendars.ok ? (
        <InlineAlert tone="danger">{t(`${P}.loadFailed`)}</InlineAlert>
      ) : calendars.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.holidays.empty`)}</p>
      ) : (
        <ul
          aria-label={t(`${P}.holidays.title`)}
          className="m-0 flex list-none flex-col gap-12 p-0"
        >
          {calendars.data.map((c) => (
            <li key={c.id} className={ROW}>
              <div className="flex flex-col gap-4">
                <span className="text-text-14 font-semibold">{c.name}</span>
                <span className="text-text-12 text-text-secondary">{scopeOf(t, c)}</span>
              </div>
              {c.holidays.length === 0 ? (
                <p className="m-0 text-text-13 text-text-secondary">
                  {t(`${P}.holidays.noHolidays`)}
                </p>
              ) : (
                <ul
                  aria-label={t(`${P}.holidays.holidaysOf`, { name: c.name })}
                  className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
                >
                  {c.holidays.map((h) => (
                    <li
                      key={h.id}
                      className="flex flex-wrap items-center justify-between gap-8 py-6"
                    >
                      <span className="flex flex-col">
                        <span className="text-text-13 font-medium">
                          {t(`${P}.holidays.holidayLine`, {
                            date: day(h.observedOn),
                            name: h.name,
                          })}
                        </span>
                        <span className="text-text-12 text-text-secondary">
                          {h.paidHours > 0
                            ? t(`${P}.holidays.paid`, { hours: format.number(h.paidHours) })
                            : t(`${P}.holidays.unpaid`)}
                        </span>
                      </span>
                      {canEdit ? (
                        <ActionForm
                          action={holidayAction}
                          hidden={{ org, intent: "remove", id: h.id }}
                          label={t(`${P}.holidays.remove`, { name: h.name })}
                          submitLabel={t(`${P}.holidays.remove`, { name: h.name })}
                          submitVariant="ghost"
                          inline
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {canEdit ? (
                <div className="flex flex-col gap-12">
                  <ActionForm
                    action={holidayAction}
                    hidden={{ org, intent: "add", calendar: c.id }}
                    label={t(`${P}.holidays.addHolidayTo`, { name: c.name })}
                    submitLabel={t(`${P}.holidays.addHoliday`)}
                    submitVariant="secondary"
                    success={t(`${P}.added`)}
                  >
                    <div className="flex flex-wrap items-end gap-12">
                      <Input
                        id={`holiday-${c.id}-date`}
                        name="observedOn"
                        type="date"
                        label={t(`${P}.holidays.date`)}
                        required
                        width={180}
                      />
                      <Input
                        id={`holiday-${c.id}-name`}
                        name="name"
                        label={t(`${P}.holidays.holidayName`)}
                        maxLength={100}
                        required
                      />
                      <Input
                        id={`holiday-${c.id}-hours`}
                        name="paidHours"
                        type="number"
                        min={0}
                        max={24}
                        step={0.25}
                        defaultValue="8"
                        label={t(`${P}.holidays.paidHours`)}
                        help={t(`${P}.holidays.paidHoursHelp`)}
                        width={160}
                      />
                    </div>
                  </ActionForm>
                  {c.venues.length > 0 ? (
                    <ul
                      aria-label={t(`${P}.holidays.venuesOf`, { name: c.name })}
                      className="m-0 flex list-none flex-wrap gap-8 p-0"
                    >
                      {c.venues.map((v) => (
                        <li key={v.assignmentId}>
                          <ActionForm
                            action={holidayVenueAction}
                            hidden={{ org, intent: "unassign", id: v.assignmentId }}
                            label={t(`${P}.holidays.unassign`, { name: v.name })}
                            submitLabel={t(`${P}.holidays.unassign`, { name: v.name })}
                            submitVariant="ghost"
                            inline
                          />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {free.length > 0 ? (
                    <ActionForm
                      action={holidayVenueAction}
                      hidden={{ org, intent: "assign", calendar: c.id }}
                      label={t(`${P}.holidays.assignTo`, { name: c.name })}
                      submitLabel={t(`${P}.holidays.assign`)}
                      submitVariant="secondary"
                      inline
                    >
                      <Select
                        id={`venue-${c.id}`}
                        name="venue"
                        label={t(`${P}.holidays.venue`)}
                        options={free.map((v) => ({ value: v.id, label: v.name }))}
                      />
                    </ActionForm>
                  ) : null}
                  <div className="flex flex-wrap items-start gap-16">
                    <Edit summary={t(`${P}.holidays.editCalendar`, { name: c.name })}>
                      <ActionForm
                        action={holidayCalendarAction}
                        hidden={{ org, intent: "update", id: c.id }}
                        label={t(`${P}.holidays.editCalendar`, { name: c.name })}
                        submitLabel={t(`${P}.save`)}
                        submitVariant="secondary"
                        success={t(`${P}.saved`)}
                      >
                        <CalendarFields t={t} idPrefix={`calendar-${c.id}`} calendar={c} />
                      </ActionForm>
                    </Edit>
                    <ActionForm
                      action={holidayCalendarAction}
                      hidden={{ org, intent: "retire", id: c.id }}
                      label={t(`${P}.holidays.retireCalendar`, { name: c.name })}
                      submitLabel={t(`${P}.holidays.retireCalendar`, { name: c.name })}
                      submitVariant="ghost"
                      inline
                    />
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="flex flex-col gap-8">
          <h3 className="m-0 text-text-14 font-semibold">{t(`${P}.holidays.addCalendarTitle`)}</h3>
          <ActionForm
            action={holidayCalendarAction}
            hidden={{ org, intent: "create" }}
            label={t(`${P}.holidays.addCalendarTitle`)}
            submitLabel={t(`${P}.holidays.addCalendar`)}
            success={t(`${P}.added`)}
          >
            <CalendarFields t={t} idPrefix="calendar-new" />
          </ActionForm>
        </div>
      ) : null}
    </Section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.payroll-and-time-off", order: 20, Panel: EarningCodesPanel },
  { node: "settings.payroll-and-time-off", order: 30, Panel: TimeOffPoliciesPanel },
  { node: "settings.payroll-and-time-off", order: 40, Panel: HolidayCalendarsPanel },
];
