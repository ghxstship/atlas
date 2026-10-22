import type { Member } from "@xos/data";
import {
  OSHA_CASE_TYPES,
  OSHA_OUTCOMES,
  getOshaAnnualSummary,
  getOshaEmploymentEstimate,
  listOshaCases,
  listOshaEstablishments,
  type OshaEstablishment,
} from "@xos/data/osha";
import type { Route } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ActionForm } from "@/components/operations/action-form";
import { SelectField, TextAreaField, TextField } from "@/components/operations/fields";
import { Button, DownloadLink } from "@/components/ui";
import {
  createEstablishmentAction,
  recordOshaCaseAction,
  saveOshaSummaryAction,
} from "@/lib/compliance/actions";
import type { OrgContext } from "@/lib/shell/context";

/**
 * OSHA recordkeeping in Atlas (Section 14.5, 29 CFR Part 1904; migration 1385, ADR 0041). Settings,
 * Locations and Venues lists the establishments with their Form 300 and 300A for a year and the
 * summary's employment figures and certification; an incident's record carries its recordable cases
 * and Form 301. Cases are health information: only holders of data.restricted.read.medical see them.
 */

type T = (key: string, values?: Record<string, string | number>) => string;

async function copy(): Promise<T> {
  return (await getTranslations("compliance.osha")) as unknown as T;
}

function DownloadForm({
  org,
  form,
  id,
  year,
  label,
  t,
}: {
  org: string;
  form: "osha-300" | "osha-300a";
  id: string;
  year: number;
  label: string;
  t: T;
}) {
  return (
    <form
      method="get"
      action={`/${org}/forms/${form}/${id}`}
      className="flex flex-wrap items-end gap-8"
    >
      <input type="hidden" name="year" value={year} />
      <span className="text-text-13 font-medium">{label}</span>
      <Button type="submit" name="format" value="pdf" variant="secondary">
        {t("pdf")}
      </Button>
      <Button type="submit" name="format" value="csv" variant="ghost">
        {t("csv")}
      </Button>
    </form>
  );
}

async function EstablishmentCard({
  ctx,
  establishment,
  year,
  t,
}: {
  ctx: OrgContext;
  establishment: OshaEstablishment;
  year: number;
  t: T;
}) {
  const canWrite = ctx.capabilities.has("safety.incident.close");
  const canMedical = ctx.capabilities.has("data.restricted.read.medical");
  const [summary, estimate] = await Promise.all([
    getOshaAnnualSummary(ctx.viewer.db, establishment.id, year),
    canWrite ? getOshaEmploymentEstimate(ctx.viewer.db, ctx.org.id, year) : null,
  ]);
  const saved = summary.ok ? summary.data : null;
  const place = [establishment.locality, establishment.regionCode].filter(Boolean).join(", ");
  return (
    <li className="flex flex-col gap-12 rounded-card border border-border-subtle p-16">
      <div className="flex flex-col gap-4">
        <span className="text-label-14 font-medium">{establishment.name}</span>
        {place ? <span className="text-text-13 text-text-secondary">{place}</span> : null}
      </div>
      <div className="flex flex-col gap-8">
        {canMedical ? (
          <DownloadForm
            org={ctx.org.slug}
            form="osha-300"
            id={establishment.id}
            year={year}
            label={t("log", { year })}
            t={t}
          />
        ) : null}
        <DownloadForm
          org={ctx.org.slug}
          form="osha-300a"
          id={establishment.id}
          year={year}
          label={t("summary", { year })}
          t={t}
        />
      </div>
      {canWrite ? (
        <details className="flex flex-col gap-8">
          <summary className="cursor-pointer text-text-13 font-medium">
            {t("summaryForm", { year })}
          </summary>
          {estimate && estimate.ok ? (
            <p className="m-0 text-text-13 text-text-secondary">
              {t("estimate", {
                hours: estimate.data.totalHoursWorked,
                employees: estimate.data.annualAverageEmployees,
              })}
            </p>
          ) : null}
          <ActionForm
            action={saveOshaSummaryAction}
            hidden={{ org: ctx.org.slug, establishment: establishment.id, year: String(year) }}
            submitLabel={t("saveSummary")}
            successKey="compliance.osha.summarySaved"
            variant="secondary"
          >
            <TextField
              id={`employees-${establishment.id}`}
              name="employees"
              type="number"
              min={0}
              label={t("employees")}
              defaultValue={saved?.annualAverageEmployees ?? ""}
            />
            <TextField
              id={`hours-${establishment.id}`}
              name="hours"
              type="number"
              min={0}
              label={t("hours")}
              defaultValue={saved?.totalHoursWorked ?? ""}
            />
            <TextField
              id={`title-${establishment.id}`}
              name="title"
              label={t("executiveTitle")}
              maxLength={100}
              defaultValue={saved?.certifierTitle ?? ""}
            />
            <TextField
              id={`phone-${establishment.id}`}
              name="phone"
              type="tel"
              label={t("phone")}
              maxLength={30}
              defaultValue={saved?.certifierPhone ?? ""}
            />
            <label className="flex items-start gap-8 text-text-13">
              <input type="checkbox" name="certify" className="mt-2" />
              <span>{t("certify")}</span>
            </label>
          </ActionForm>
          {saved?.certifiedByName ? (
            <p className="m-0 text-text-13 text-text-secondary">
              {t("certifiedBy", { name: saved.certifiedByName, date: saved.certifiedOn ?? "" })}
            </p>
          ) : null}
        </details>
      ) : null}
    </li>
  );
}

/** Settings, Locations and Venues: OSHA establishments and their forms for the current year and the last. */
export async function OshaEstablishmentsPanel({ ctx }: { ctx: OrgContext }) {
  if (!ctx.capabilities.has("safety.incident.read")) return null;
  const t = await copy();
  const establishments = await listOshaEstablishments(ctx.viewer.db, ctx.org.id);
  const list = establishments.ok ? establishments.data : [];
  const thisYear = new Date().getUTCFullYear();
  const canWrite = ctx.capabilities.has("safety.incident.close");
  return (
    <section aria-labelledby="osha-heading" className="flex flex-col gap-12">
      <header className="flex flex-col gap-4">
        <h2 id="osha-heading" className="m-0 text-heading-16 font-semibold">
          {t("title")}
        </h2>
        <p className="m-0 text-text-secondary">{t("lead")}</p>
      </header>
      {list.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("none")}</p>
      ) : (
        [thisYear, thisYear - 1].map((year) => (
          <div key={year} className="flex flex-col gap-8">
            <h3 className="m-0 text-label-14 font-medium">{t("year", { year })}</h3>
            <ul className="m-0 flex list-none flex-col gap-12 p-0">
              {list.map((e) => (
                <EstablishmentCard
                  key={`${e.id}-${year}`}
                  ctx={ctx}
                  establishment={e}
                  year={year}
                  t={t}
                />
              ))}
            </ul>
          </div>
        ))
      )}
      {canWrite ? (
        <details className="flex flex-col gap-8">
          <summary className="cursor-pointer text-text-13 font-medium">{t("add")}</summary>
          <ActionForm
            action={createEstablishmentAction}
            hidden={{ org: ctx.org.slug }}
            submitLabel={t("addSubmit")}
            successKey="compliance.osha.added"
            resetOnSuccess
          >
            <TextField
              id="osha-name"
              name="name"
              label={t("fields.name")}
              required
              maxLength={200}
            />
            <TextField id="osha-street" name="street" label={t("fields.street")} maxLength={200} />
            <TextField id="osha-city" name="city" label={t("fields.city")} maxLength={100} />
            <TextField
              id="osha-state"
              name="state"
              label={t("fields.state")}
              help={t("fields.stateHelp")}
              maxLength={2}
            />
            <TextField id="osha-zip" name="zip" label={t("fields.zip")} maxLength={10} />
            <TextField id="osha-naics" name="naics" label={t("fields.naics")} maxLength={6} />
            <TextField
              id="osha-industry"
              name="industry"
              label={t("fields.industry")}
              maxLength={200}
            />
          </ActionForm>
        </details>
      ) : null}
    </section>
  );
}

/** An incident's recordable cases (Forms 300 and 301), for holders of the medical capability. */
export async function IncidentOshaPanel({
  ctx,
  incidentId,
  members,
}: {
  ctx: OrgContext;
  incidentId: string;
  members: readonly Member[];
}) {
  if (!ctx.capabilities.has("data.restricted.read.medical")) return null;
  const t = await copy();
  const [cases, establishments] = await Promise.all([
    listOshaCases(ctx.viewer.db, { incidentId }),
    listOshaEstablishments(ctx.viewer.db, ctx.org.id),
  ]);
  const list = cases.ok ? cases.data : [];
  const places = establishments.ok ? establishments.data : [];
  const canWrite = ctx.capabilities.has("safety.incident.close");
  const options = (values: readonly string[], prefix: string) =>
    values.map((value) => ({ value, label: t(`${prefix}.${value}`) }));
  return (
    <section aria-labelledby={`osha-case-${incidentId}`} className="flex flex-col gap-12">
      <h3 id={`osha-case-${incidentId}`} className="m-0 text-label-14 font-semibold">
        {t("cases")}
      </h3>
      {list.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("noCases")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-8 p-0">
          {list.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-12 text-text-13">
              <span>
                {t("caseLine", {
                  number: c.caseNumber,
                  year: c.logYear,
                  name: c.privacyCase ? t("privacyCase") : c.employeeName,
                  outcome: t(`outcomes.${c.outcome}`),
                })}
              </span>
              <DownloadLink href={`/${ctx.org.slug}/forms/osha-301/${c.id}`}>
                {t("form301")}
              </DownloadLink>
            </li>
          ))}
        </ul>
      )}
      {canWrite && places.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {t("needsEstablishment")}{" "}
          <Link
            className="text-accent-text underline"
            href={`/${ctx.org.slug}/settings/locations-and-venues` as Route}
          >
            {t("addEstablishment")}
          </Link>
        </p>
      ) : null}
      {canWrite && places.length > 0 ? (
        <details className="flex flex-col gap-8">
          <summary className="cursor-pointer text-text-13 font-medium">{t("record")}</summary>
          <ActionForm
            action={recordOshaCaseAction}
            hidden={{ org: ctx.org.slug, incident: incidentId }}
            submitLabel={t("recordSubmit")}
            successKey="compliance.osha.recorded"
            resetOnSuccess
          >
            <SelectField
              id="case-establishment"
              name="establishment"
              label={t("fields.establishment")}
              required
              options={places.map((p) => ({ value: p.id, label: p.name }))}
            />
            <SelectField
              id="case-person"
              name="person"
              label={t("fields.person")}
              options={[
                { value: "", label: t("fields.notMember") },
                ...members.map((m) => ({ value: m.personId, label: m.fullName ?? m.personId })),
              ]}
            />
            <TextField
              id="case-name"
              name="employeeName"
              label={t("fields.employeeName")}
              help={t("fields.employeeNameHelp")}
              maxLength={200}
            />
            <label className="flex items-start gap-8 text-text-13">
              <input type="checkbox" name="privacy" className="mt-2" />
              <span>{t("fields.privacy")}</span>
            </label>
            <TextField
              id="case-job"
              name="jobTitle"
              label={t("fields.jobTitle")}
              required
              maxLength={100}
            />
            <TextField
              id="case-date"
              name="injuryDate"
              type="date"
              label={t("fields.injuryDate")}
              required
            />
            <TextField
              id="case-where"
              name="eventLocation"
              label={t("fields.eventLocation")}
              required
              maxLength={200}
            />
            <TextAreaField
              id="case-description"
              name="description"
              label={t("fields.description")}
              required
              maxLength={500}
            />
            <SelectField
              id="case-outcome"
              name="outcome"
              label={t("fields.outcome")}
              required
              options={options(OSHA_OUTCOMES, "outcomes")}
            />
            <TextField
              id="case-away"
              name="daysAway"
              type="number"
              min={0}
              label={t("fields.daysAway")}
              help={t("fields.daysHelp")}
            />
            <TextField
              id="case-restricted"
              name="daysRestricted"
              type="number"
              min={0}
              label={t("fields.daysRestricted")}
            />
            <SelectField
              id="case-type"
              name="caseType"
              label={t("fields.caseType")}
              required
              options={options(OSHA_CASE_TYPES, "types")}
            />
            <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
              <legend className="mb-4 text-label-14 font-medium">{t("form301Details")}</legend>
              <TextField
                id="case-street"
                name="employeeStreet"
                label={t("fields.employeeStreet")}
                maxLength={200}
              />
              <TextField
                id="case-city"
                name="employeeCity"
                label={t("fields.employeeCity")}
                maxLength={100}
              />
              <TextField
                id="case-state"
                name="employeeState"
                label={t("fields.employeeState")}
                maxLength={2}
              />
              <TextField
                id="case-zip"
                name="employeeZip"
                label={t("fields.employeeZip")}
                maxLength={10}
              />
              <TextField
                id="case-birth"
                name="dateOfBirth"
                type="date"
                label={t("fields.dateOfBirth")}
              />
              <TextField
                id="case-hired"
                name="dateHired"
                type="date"
                label={t("fields.dateHired")}
              />
              <SelectField
                id="case-sex"
                name="sex"
                label={t("fields.sex")}
                options={[
                  { value: "", label: t("fields.unanswered") },
                  { value: "Male", label: t("fields.male") },
                  { value: "Female", label: t("fields.female") },
                ]}
              />
              <TextField
                id="case-professional"
                name="professional"
                label={t("fields.professional")}
                maxLength={200}
              />
              <TextField
                id="case-facility"
                name="facility"
                label={t("fields.facility")}
                maxLength={200}
              />
              <TextField
                id="case-facility-street"
                name="facilityStreet"
                label={t("fields.facilityStreet")}
                maxLength={200}
              />
              <TextField
                id="case-facility-city"
                name="facilityCity"
                label={t("fields.facilityCity")}
                maxLength={100}
              />
              <TextField
                id="case-facility-state"
                name="facilityState"
                label={t("fields.facilityState")}
                maxLength={2}
              />
              <TextField
                id="case-facility-zip"
                name="facilityZip"
                label={t("fields.facilityZip")}
                maxLength={10}
              />
              <SelectField
                id="case-er"
                name="emergencyRoom"
                label={t("fields.emergencyRoom")}
                options={[
                  { value: "", label: t("fields.unanswered") },
                  { value: "yes", label: t("fields.yes") },
                  { value: "no", label: t("fields.no") },
                ]}
              />
              <SelectField
                id="case-hospital"
                name="hospitalized"
                label={t("fields.hospitalized")}
                options={[
                  { value: "", label: t("fields.unanswered") },
                  { value: "yes", label: t("fields.yes") },
                  { value: "no", label: t("fields.no") },
                ]}
              />
              <TextField
                id="case-began"
                name="workBegan"
                type="time"
                label={t("fields.workBegan")}
              />
              <TextField
                id="case-time"
                name="eventTime"
                type="time"
                label={t("fields.eventTime")}
              />
              <label className="flex items-start gap-8 text-text-13">
                <input type="checkbox" name="timeUnknown" className="mt-2" />
                <span>{t("fields.timeUnknown")}</span>
              </label>
              <TextAreaField
                id="case-before"
                name="activityBefore"
                label={t("fields.activityBefore")}
                help={t("fields.noPii")}
                maxLength={2000}
              />
              <TextAreaField
                id="case-happened"
                name="whatHappened"
                label={t("fields.whatHappened")}
                help={t("fields.noPii")}
                maxLength={2000}
              />
              <TextAreaField
                id="case-injury"
                name="injuryDetail"
                label={t("fields.injuryDetail")}
                help={t("fields.noPii")}
                maxLength={2000}
              />
              <TextField
                id="case-object"
                name="harmfulObject"
                label={t("fields.harmfulObject")}
                help={t("fields.noPii")}
                maxLength={500}
              />
              <TextField id="case-died" name="diedOn" type="date" label={t("fields.diedOn")} />
              <TextField
                id="case-completed-title"
                name="completedTitle"
                label={t("fields.completedTitle")}
                maxLength={100}
              />
              <TextField
                id="case-completed-phone"
                name="completedPhone"
                type="tel"
                label={t("fields.completedPhone")}
                maxLength={30}
              />
            </fieldset>
          </ActionForm>
        </details>
      ) : null}
    </section>
  );
}
