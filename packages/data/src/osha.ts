import type { XosClient } from "./client.ts";
import { complianceModel, complianceTools, toCsvFile } from "./documents/compliance.ts";
import type { DocumentBlock, DocumentModel } from "./documents/model.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * OSHA injury and illness recordkeeping (29 CFR Part 1904; Section 14.5, finding A65-014; migration
 * 1385): establishments, recordable cases and the annual summary, and Forms 300, 300A and 301 as
 * tagged PDF/UA-1 (ADR 0031) and CSV. The columns and items are those of the official forms (OSHA
 * Forms Rev. 04/2004, OMB 1218-0176; ADR 0041 maps each one), nothing more. Cases are health
 * information: the database lets only holders of data.restricted.read.medical read them, and every
 * PDF carries the Section 8.6 watermark.
 */

export const OSHA_OUTCOMES = [
  "Death",
  "Days away from work",
  "Job transfer or restriction",
  "Other recordable case",
] as const;
export type OshaOutcome = (typeof OSHA_OUTCOMES)[number];

export const OSHA_CASE_TYPES = [
  "Injury",
  "Skin disorder",
  "Respiratory condition",
  "Poisoning",
  "Hearing loss",
  "All other illnesses",
] as const;
export type OshaCaseType = (typeof OSHA_CASE_TYPES)[number];

export interface OshaEstablishment {
  readonly id: string;
  readonly name: string;
  readonly streetAddress: string | null;
  readonly locality: string | null;
  readonly regionCode: string | null;
  readonly postalCode: string | null;
  readonly naicsCode: string | null;
  readonly industryDescription: string | null;
}

export interface OshaCase {
  readonly id: string;
  readonly establishmentId: string;
  readonly incidentId: string | null;
  readonly logYear: number;
  readonly caseNumber: string;
  readonly personId: string | null;
  /** The employee's full name: the person's, else the name typed on the case. */
  readonly employeeName: string;
  readonly privacyCase: boolean;
  readonly jobTitle: string;
  readonly injuryDate: string;
  readonly eventLocation: string;
  readonly description: string;
  readonly outcome: OshaOutcome;
  readonly daysAway: number;
  readonly daysRestricted: number;
  readonly caseType: OshaCaseType;
  readonly employeeStreet: string | null;
  readonly employeeLocality: string | null;
  readonly employeeRegion: string | null;
  readonly employeePostalCode: string | null;
  readonly dateOfBirth: string | null;
  readonly dateHired: string | null;
  readonly employeeSex: "Male" | "Female" | null;
  readonly healthCareProfessional: string | null;
  readonly treatmentFacility: string | null;
  readonly facilityStreet: string | null;
  readonly facilityLocality: string | null;
  readonly facilityRegion: string | null;
  readonly facilityPostalCode: string | null;
  readonly emergencyRoom: boolean | null;
  readonly hospitalizedOvernight: boolean | null;
  readonly workBeganAt: string | null;
  readonly eventTime: string | null;
  readonly eventTimeUnknown: boolean;
  readonly activityBefore: string | null;
  readonly whatHappened: string | null;
  readonly injuryDetail: string | null;
  readonly harmfulObject: string | null;
  readonly diedOn: string | null;
  readonly completedByName: string | null;
  readonly completedTitle: string | null;
  readonly completedPhone: string | null;
  readonly completedOn: string | null;
}

export interface OshaTotals {
  readonly deaths: number;
  readonly daysAwayCases: number;
  readonly restrictedCases: number;
  readonly otherCases: number;
  readonly daysAway: number;
  readonly daysRestricted: number;
  readonly injuries: number;
  readonly skinDisorders: number;
  readonly respiratoryConditions: number;
  readonly poisonings: number;
  readonly hearingLoss: number;
  readonly otherIllnesses: number;
}

export interface OshaAnnualSummary {
  readonly annualAverageEmployees: number | null;
  readonly totalHoursWorked: number | null;
  readonly certifiedByName: string | null;
  readonly certifierTitle: string | null;
  readonly certifierPhone: string | null;
  readonly certifiedOn: string | null;
}

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number => Number(v ?? 0);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const nameOf = (v: unknown): string | null =>
  v && typeof v === "object" ? text((v as Record<string, unknown>)["full_name"]) : null;

const ESTABLISHMENT_COLUMNS =
  "id, name, street_address, locality, region_code, postal_code, naics_code, industry_description";

function toEstablishment(r: Record<string, unknown>): OshaEstablishment {
  return {
    id: String(r["id"]),
    name: String(r["name"]),
    streetAddress: text(r["street_address"]),
    locality: text(r["locality"]),
    regionCode: text(r["region_code"]),
    postalCode: text(r["postal_code"]),
    naicsCode: text(r["naics_code"]),
    industryDescription: text(r["industry_description"]),
  };
}

const CASE_COLUMNS = [
  "id, establishment_id, incident_id, log_year, case_number, person_id, employee_name, privacy_case",
  "job_title, injury_date, event_location, description, outcome, days_away, days_restricted, case_type",
  "employee_street, employee_locality, employee_region, employee_postal_code, date_of_birth, date_hired, employee_sex",
  "health_care_professional, treatment_facility, facility_street, facility_locality, facility_region, facility_postal_code",
  "emergency_room, hospitalized_overnight, work_began_at, event_time, event_time_unknown",
  "activity_before, what_happened, injury_detail, harmful_object, died_on, completed_title, completed_phone, completed_on",
  "person:people!osha_cases_person_id_fkey(full_name), completer:people!osha_cases_completed_by_fkey(full_name)",
].join(", ");

function toCase(r: Record<string, unknown>): OshaCase {
  return {
    id: String(r["id"]),
    establishmentId: String(r["establishment_id"]),
    incidentId: text(r["incident_id"]),
    logYear: num(r["log_year"]),
    caseNumber: String(r["case_number"] ?? ""),
    personId: text(r["person_id"]),
    employeeName: nameOf(r["person"]) ?? text(r["employee_name"]) ?? "",
    privacyCase: r["privacy_case"] === true,
    jobTitle: String(r["job_title"] ?? ""),
    injuryDate: String(r["injury_date"] ?? ""),
    eventLocation: String(r["event_location"] ?? ""),
    description: String(r["description"] ?? ""),
    outcome: r["outcome"] as OshaOutcome,
    daysAway: num(r["days_away"]),
    daysRestricted: num(r["days_restricted"]),
    caseType: r["case_type"] as OshaCaseType,
    employeeStreet: text(r["employee_street"]),
    employeeLocality: text(r["employee_locality"]),
    employeeRegion: text(r["employee_region"]),
    employeePostalCode: text(r["employee_postal_code"]),
    dateOfBirth: text(r["date_of_birth"]),
    dateHired: text(r["date_hired"]),
    employeeSex:
      r["employee_sex"] === "Male" || r["employee_sex"] === "Female" ? r["employee_sex"] : null,
    healthCareProfessional: text(r["health_care_professional"]),
    treatmentFacility: text(r["treatment_facility"]),
    facilityStreet: text(r["facility_street"]),
    facilityLocality: text(r["facility_locality"]),
    facilityRegion: text(r["facility_region"]),
    facilityPostalCode: text(r["facility_postal_code"]),
    emergencyRoom: bool(r["emergency_room"]),
    hospitalizedOvernight: bool(r["hospitalized_overnight"]),
    workBeganAt: text(r["work_began_at"]),
    eventTime: text(r["event_time"]),
    eventTimeUnknown: r["event_time_unknown"] === true,
    activityBefore: text(r["activity_before"]),
    whatHappened: text(r["what_happened"]),
    injuryDetail: text(r["injury_detail"]),
    harmfulObject: text(r["harmful_object"]),
    diedOn: text(r["died_on"]),
    completedByName: nameOf(r["completer"]),
    completedTitle: text(r["completed_title"]),
    completedPhone: text(r["completed_phone"]),
    completedOn: text(r["completed_on"]),
  };
}

type Loose = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: unknown): unknown;
    };
  };
};

function loose(db: XosClient): Loose {
  return db as unknown as Loose;
}

type Query = PromiseLike<{
  data: unknown;
  error: { code?: string; message: string } | null;
}> & {
  eq(column: string, value: unknown): Query;
  is(column: string, value: null): Query;
  order(column: string, options?: { ascending?: boolean }): Query;
  maybeSingle(): Query;
};

function select(db: XosClient, table: string, columns: string): Query {
  return loose(db).from(table).select(columns) as unknown as Query;
}

export async function listOshaEstablishments(
  db: XosClient,
  orgId: string,
): Promise<Result<OshaEstablishment[]>> {
  const { data, error } = await select(db, "osha_establishments", ESTABLISHMENT_COLUMNS)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name");
  if (error) return fail(toDataError(error));
  return ok(((data ?? []) as Record<string, unknown>[]).map(toEstablishment));
}

export async function getOshaEstablishment(
  db: XosClient,
  id: string,
): Promise<Result<OshaEstablishment | null>> {
  const { data, error } = await select(db, "osha_establishments", ESTABLISHMENT_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  return ok(data ? toEstablishment(data as Record<string, unknown>) : null);
}

export interface OshaEstablishmentInput {
  readonly orgId: string;
  readonly name: string;
  readonly streetAddress: string | null;
  readonly locality: string | null;
  readonly regionCode: string | null;
  readonly postalCode: string | null;
  readonly naicsCode: string | null;
  readonly industryDescription: string | null;
}

export async function createOshaEstablishment(
  db: XosClient,
  input: OshaEstablishmentInput,
): Promise<Result<string>> {
  const { data, error } = await (
    db as unknown as {
      from(t: string): {
        insert(row: Record<string, unknown>): {
          select(c: string): { single(): PromiseLike<{ data: unknown; error: never }> };
        };
      };
    }
  )
    .from("osha_establishments")
    .insert({
      org_id: input.orgId,
      name: input.name,
      street_address: input.streetAddress,
      locality: input.locality,
      region_code: input.regionCode,
      postal_code: input.postalCode,
      naics_code: input.naicsCode,
      industry_description: input.industryDescription,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok(String((data as { id: string }).id));
}

export async function listOshaCases(
  db: XosClient,
  filter: {
    readonly establishmentId?: string;
    readonly year?: number;
    readonly incidentId?: string;
  },
): Promise<Result<OshaCase[]>> {
  let query = select(db, "osha_cases", CASE_COLUMNS).is("deleted_at", null);
  if (filter.establishmentId) query = query.eq("establishment_id", filter.establishmentId);
  if (filter.year) query = query.eq("log_year", filter.year);
  if (filter.incidentId) query = query.eq("incident_id", filter.incidentId);
  const { data, error } = await query.order("case_number");
  if (error) return fail(toDataError(error));
  return ok(((data ?? []) as Record<string, unknown>[]).map(toCase));
}

export async function getOshaCase(db: XosClient, id: string): Promise<Result<OshaCase | null>> {
  const { data, error } = await select(db, "osha_cases", CASE_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  return ok(data ? toCase(data as Record<string, unknown>) : null);
}

/** The writable fields of a case, by database column. */
export type OshaCaseInput = Readonly<Record<string, string | number | boolean | null>>;

/** Records a case, or changes one when `id` is given. Answers the case id. */
export async function saveOshaCase(
  db: XosClient,
  input: OshaCaseInput,
  id?: string,
): Promise<Result<string>> {
  const table = (
    db as unknown as {
      from(t: string): {
        insert(row: OshaCaseInput): {
          select(c: string): { single(): PromiseLike<{ data: unknown; error: never }> };
        };
        update(row: OshaCaseInput): {
          eq(
            c: string,
            v: string,
          ): { select(c: string): { single(): PromiseLike<{ data: unknown; error: never }> } };
        };
      };
    }
  ).from("osha_cases");
  const { data, error } = id
    ? await table.update(input).eq("id", id).select("id").single()
    : await table.insert(input).select("id").single();
  if (error) return fail(toDataError(error));
  return ok(String((data as { id: string }).id));
}

export async function getOshaTotals(
  db: XosClient,
  establishmentId: string,
  year: number,
): Promise<Result<OshaTotals>> {
  const { data, error } = await db.rpc("osha_summary", {
    p_establishment_id: establishmentId,
    p_year: year,
  });
  if (error) return fail(toDataError(error));
  const r = ((Array.isArray(data) ? data[0] : data) ?? {}) as Record<string, unknown>;
  return ok({
    deaths: num(r["deaths"]),
    daysAwayCases: num(r["days_away_cases"]),
    restrictedCases: num(r["restricted_cases"]),
    otherCases: num(r["other_cases"]),
    daysAway: num(r["days_away"]),
    daysRestricted: num(r["days_restricted"]),
    injuries: num(r["injuries"]),
    skinDisorders: num(r["skin_disorders"]),
    respiratoryConditions: num(r["respiratory_conditions"]),
    poisonings: num(r["poisonings"]),
    hearingLoss: num(r["hearing_loss"]),
    otherIllnesses: num(r["other_illnesses"]),
  });
}

export async function getOshaAnnualSummary(
  db: XosClient,
  establishmentId: string,
  year: number,
): Promise<Result<OshaAnnualSummary | null>> {
  const { data, error } = await select(
    db,
    "osha_annual_summaries",
    "annual_average_employees, total_hours_worked, certifier_title, certifier_phone, certified_on, certifier:people!osha_annual_summaries_certified_by_fkey(full_name)",
  )
    .eq("establishment_id", establishmentId)
    .eq("log_year", year)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return ok(null);
  const r = data as Record<string, unknown>;
  return ok({
    annualAverageEmployees:
      (r["annual_average_employees"] ?? null) === null ? null : num(r["annual_average_employees"]),
    totalHoursWorked:
      (r["total_hours_worked"] ?? null) === null ? null : num(r["total_hours_worked"]),
    certifiedByName: nameOf(r["certifier"]),
    certifierTitle: text(r["certifier_title"]),
    certifierPhone: text(r["certifier_phone"]),
    certifiedOn: text(r["certified_on"]),
  });
}

export async function getOshaEmploymentEstimate(
  db: XosClient,
  orgId: string,
  year: number,
): Promise<Result<{ totalHoursWorked: number; annualAverageEmployees: number }>> {
  const { data, error } = await db.rpc("osha_employment_estimate", {
    p_org_id: orgId,
    p_year: year,
  });
  if (error) return fail(toDataError(error));
  const r = ((Array.isArray(data) ? data[0] : data) ?? {}) as Record<string, unknown>;
  return ok({
    totalHoursWorked: num(r["total_hours_worked"]),
    annualAverageEmployees: num(r["annual_average_employees"]),
  });
}

// The forms ---------------------------------------------------------------------------------------

/** Form 300 column B: a privacy concern case prints "privacy case" (29 CFR 1904.29(b)(6)). */
export function logName(c: OshaCase, privacyLabel: string): string {
  return c.privacyCase ? privacyLabel : c.employeeName;
}

const X = (on: boolean): string => (on ? "X" : "");

/** A summary figure formatted, or the fallback when it was not entered. */
function figure(
  value: number | null | undefined,
  show: (v: number) => string,
  fallback: string,
): string {
  return typeof value === "number" ? show(value) : fallback;
}

/** Form 300 header row, in column order A to M. The labels are the form's own, in English. */
export const OSHA_300_COLUMNS = [
  "(A) Case no.",
  "(B) Employee's name",
  "(C) Job title",
  "(D) Date of injury or onset of illness",
  "(E) Where the event occurred",
  "(F) Describe injury or illness, parts of body affected, and object/substance that directly injured or made person ill",
  "(G) Death",
  "(H) Days away from work",
  "(I) Job transfer or restriction",
  "(J) Other recordable cases",
  "(K) Away from work (days)",
  "(L) On job transfer or restriction (days)",
  "(M1) Injury",
  "(M2) Skin disorder",
  "(M3) Respiratory condition",
  "(M4) Poisoning",
  "(M5) Hearing loss",
  "(M6) All other illnesses",
] as const;

function log300Cells(c: OshaCase, privacyLabel: string): string[] {
  return [
    c.caseNumber,
    logName(c, privacyLabel),
    c.jobTitle,
    c.injuryDate,
    c.eventLocation,
    c.description,
    X(c.outcome === "Death"),
    X(c.outcome === "Days away from work"),
    X(c.outcome === "Job transfer or restriction"),
    X(c.outcome === "Other recordable case"),
    String(c.daysAway),
    String(c.daysRestricted),
    ...OSHA_CASE_TYPES.map((type) => X(c.caseType === type)),
  ];
}

/** The Form 300 log as CSV: one row per case, the form's columns A to M. */
export function osha300Csv(cases: readonly OshaCase[]): string {
  return toCsvFile(
    OSHA_300_COLUMNS,
    cases.map((c) => log300Cells(c, "privacy case")),
  );
}

/** The Form 300A as CSV: one row of the summary's fields. */
export function osha300aCsv(
  establishment: OshaEstablishment,
  year: number,
  totals: OshaTotals,
  summary: OshaAnnualSummary | null,
): string {
  return toCsvFile(
    [
      "Year",
      "Establishment name",
      "Street",
      "City",
      "State",
      "Zip",
      "Industry description",
      "NAICS",
      "Annual average number of employees",
      "Total hours worked by all employees last year",
      "(G) Total number of deaths",
      "(H) Total number of cases with days away from work",
      "(I) Total number of cases with job transfer or restriction",
      "(J) Total number of other recordable cases",
      "(K) Total number of days away from work",
      "(L) Total number of days of job transfer or restriction",
      "(M1) Injuries",
      "(M2) Skin disorders",
      "(M3) Respiratory conditions",
      "(M4) Poisonings",
      "(M5) Hearing loss",
      "(M6) All other illnesses",
      "Company executive",
      "Title",
      "Phone",
      "Date",
    ],
    [
      [
        String(year),
        establishment.name,
        establishment.streetAddress ?? "",
        establishment.locality ?? "",
        establishment.regionCode ?? "",
        establishment.postalCode ?? "",
        establishment.industryDescription ?? "",
        establishment.naicsCode ?? "",
        figure(summary?.annualAverageEmployees, String, ""),
        figure(summary?.totalHoursWorked, String, ""),
        String(totals.deaths),
        String(totals.daysAwayCases),
        String(totals.restrictedCases),
        String(totals.otherCases),
        String(totals.daysAway),
        String(totals.daysRestricted),
        String(totals.injuries),
        String(totals.skinDisorders),
        String(totals.respiratoryConditions),
        String(totals.poisonings),
        String(totals.hearingLoss),
        String(totals.otherIllnesses),
        summary?.certifiedByName ?? "",
        summary?.certifierTitle ?? "",
        summary?.certifierPhone ?? "",
        summary?.certifiedOn ?? "",
      ],
    ],
  );
}

export interface OshaFormContext {
  readonly locale: string;
  /** The `documents` namespace of the caller's catalog. */
  readonly messages: unknown;
  readonly brand: DocumentModel["brand"];
  readonly recordUrl: string;
  readonly watermark: string;
  readonly now?: Date;
}

function establishmentFields(
  e: OshaEstablishment,
  t: (k: string) => string,
  none: string,
): { label: string; value: string }[] {
  return [
    { label: t("osha.establishment.name"), value: e.name },
    { label: t("osha.establishment.street"), value: e.streetAddress ?? none },
    { label: t("osha.establishment.city"), value: e.locality ?? none },
    { label: t("osha.establishment.state"), value: e.regionCode ?? none },
    { label: t("osha.establishment.zip"), value: e.postalCode ?? none },
  ];
}

/** Form 300, Log of Work-Related Injuries and Illnesses, for an establishment and year. */
export function osha300Model(
  establishment: OshaEstablishment,
  year: number,
  cases: readonly OshaCase[],
  ctx: OshaFormContext,
): DocumentModel {
  const { t, f } = complianceTools(ctx.messages, ctx.locale);
  const none = t("common.none");
  const count = (match: (c: OshaCase) => boolean) => String(cases.filter(match).length);
  const daysAway = cases.reduce((s, c) => s + c.daysAway, 0);
  const daysRestricted = cases.reduce((s, c) => s + c.daysRestricted, 0);
  const columns = OSHA_300_COLUMNS.map((_, i) => ({
    label: t(`osha.log.columns.${i}`),
    numeric: i >= 6,
    weight: i === 5 ? 3 : i === 1 || i === 4 ? 1.6 : i >= 6 ? 0.55 : 1,
  }));
  const blocks: DocumentBlock[] = [
    { kind: "paragraph", text: t("osha.log.attention") },
    {
      kind: "fields",
      caption: t("osha.establishment.caption"),
      fields: [
        { label: t("osha.year"), value: String(year) },
        ...establishmentFields(establishment, t, none).filter((_, i) => i !== 1 && i !== 4),
      ],
    },
    {
      kind: "table",
      caption: t("osha.log.caption", { year }),
      columns,
      rows: cases.map((c) => {
        const cells = log300Cells(c, t("osha.log.privacyCase"));
        cells[3] = f.day(c.injuryDate);
        return cells;
      }),
      footer: [
        [
          t("osha.log.pageTotals"),
          "",
          "",
          "",
          "",
          "",
          ...OSHA_OUTCOMES.map((o) => count((c) => c.outcome === o)),
          String(daysAway),
          String(daysRestricted),
          ...OSHA_CASE_TYPES.map((type) => count((c) => c.caseType === type)),
        ],
      ],
      empty: t("osha.log.empty"),
    },
    { kind: "paragraph", text: t("osha.log.transfer") },
  ];
  return complianceModel({
    kind: "osha-300",
    locale: ctx.locale,
    messages: ctx.messages,
    title: t("osha.log.title", { name: establishment.name, year }),
    recordKey: t("osha.log.key", { year }),
    recordUrl: ctx.recordUrl,
    brand: ctx.brand,
    blocks,
    watermark: ctx.watermark,
    ...(ctx.now ? { now: ctx.now } : {}),
  });
}

/** Form 300A, Summary of Work-Related Injuries and Illnesses. */
export function osha300aModel(
  establishment: OshaEstablishment,
  year: number,
  totals: OshaTotals,
  summary: OshaAnnualSummary | null,
  ctx: OshaFormContext,
): DocumentModel {
  const { t, f } = complianceTools(ctx.messages, ctx.locale);
  const none = t("common.none");
  const n = (v: number) => f.number(v);
  const blocks: DocumentBlock[] = [
    { kind: "paragraph", text: t("osha.summary.intro") },
    {
      kind: "fields",
      caption: t("osha.summary.cases"),
      fields: [
        { label: t("osha.summary.deaths"), value: n(totals.deaths) },
        { label: t("osha.summary.daysAwayCases"), value: n(totals.daysAwayCases) },
        { label: t("osha.summary.restrictedCases"), value: n(totals.restrictedCases) },
        { label: t("osha.summary.otherCases"), value: n(totals.otherCases) },
      ],
    },
    {
      kind: "fields",
      caption: t("osha.summary.days"),
      fields: [
        { label: t("osha.summary.daysAway"), value: n(totals.daysAway) },
        { label: t("osha.summary.daysRestricted"), value: n(totals.daysRestricted) },
      ],
    },
    {
      kind: "fields",
      caption: t("osha.summary.types"),
      fields: [
        { label: t("osha.summary.injuries"), value: n(totals.injuries) },
        { label: t("osha.summary.skinDisorders"), value: n(totals.skinDisorders) },
        { label: t("osha.summary.respiratory"), value: n(totals.respiratoryConditions) },
        { label: t("osha.summary.poisonings"), value: n(totals.poisonings) },
        { label: t("osha.summary.hearingLoss"), value: n(totals.hearingLoss) },
        { label: t("osha.summary.otherIllnesses"), value: n(totals.otherIllnesses) },
      ],
    },
    {
      kind: "fields",
      caption: t("osha.establishment.caption"),
      fields: [
        ...establishmentFields(establishment, t, none),
        {
          label: t("osha.establishment.industry"),
          value: establishment.industryDescription ?? none,
        },
        { label: t("osha.establishment.naics"), value: establishment.naicsCode ?? none },
      ],
    },
    {
      kind: "fields",
      caption: t("osha.summary.employment"),
      fields: [
        {
          label: t("osha.summary.averageEmployees"),
          value: figure(summary?.annualAverageEmployees, n, none),
        },
        {
          label: t("osha.summary.hoursWorked"),
          value: figure(summary?.totalHoursWorked, n, none),
        },
      ],
    },
    { kind: "paragraph", text: t("osha.summary.certify") },
    {
      kind: "fields",
      caption: t("osha.summary.signHere"),
      fields: [
        { label: t("osha.summary.executive"), value: summary?.certifiedByName ?? none },
        { label: t("osha.summary.title"), value: summary?.certifierTitle ?? none },
        { label: t("osha.summary.phone"), value: summary?.certifierPhone ?? none },
        {
          label: t("osha.summary.date"),
          value: summary?.certifiedOn ? f.day(summary.certifiedOn) : none,
        },
      ],
    },
    { kind: "paragraph", text: t("osha.summary.post") },
  ];
  return complianceModel({
    kind: "osha-300a",
    locale: ctx.locale,
    messages: ctx.messages,
    title: t("osha.summary.title", { name: establishment.name, year }),
    recordKey: t("osha.summary.key", { year }),
    recordUrl: ctx.recordUrl,
    brand: ctx.brand,
    blocks,
    watermark: ctx.watermark,
    ...(ctx.now ? { now: ctx.now } : {}),
  });
}

/** Form 301, Injury and Illness Incident Report, for one case. */
export function osha301Model(
  establishment: OshaEstablishment,
  c: OshaCase,
  ctx: OshaFormContext,
): DocumentModel {
  const { t, f } = complianceTools(ctx.messages, ctx.locale);
  const none = t("common.none");
  const v = (s: string | null) => s ?? none;
  const day = (s: string | null) => (s ? f.day(s) : none);
  const yesNo = (b: boolean | null) =>
    b === null ? none : t(b ? "osha.case.yes" : "osha.case.no");
  const place = (
    street: string | null,
    city: string | null,
    state: string | null,
    zip: string | null,
  ) => [street, [city, state].filter(Boolean).join(", "), zip].filter(Boolean).join(", ") || none;
  const blocks: DocumentBlock[] = [
    { kind: "paragraph", text: t("osha.case.attention") },
    {
      kind: "fields",
      caption: t("osha.case.employee"),
      fields: [
        { label: t("osha.case.items.1"), value: c.employeeName },
        {
          label: t("osha.case.items.2"),
          value: place(
            c.employeeStreet,
            c.employeeLocality,
            c.employeeRegion,
            c.employeePostalCode,
          ),
        },
        { label: t("osha.case.items.3"), value: day(c.dateOfBirth) },
        { label: t("osha.case.items.4"), value: day(c.dateHired) },
        {
          label: t("osha.case.items.5"),
          value: c.employeeSex ? t(`osha.case.sex.${c.employeeSex}`) : none,
        },
      ],
    },
    {
      kind: "fields",
      caption: t("osha.case.physician"),
      fields: [
        { label: t("osha.case.items.6"), value: v(c.healthCareProfessional) },
        {
          label: t("osha.case.items.7"),
          value: c.treatmentFacility
            ? `${c.treatmentFacility}, ${place(c.facilityStreet, c.facilityLocality, c.facilityRegion, c.facilityPostalCode)}`
            : none,
        },
        { label: t("osha.case.items.8"), value: yesNo(c.emergencyRoom) },
        { label: t("osha.case.items.9"), value: yesNo(c.hospitalizedOvernight) },
      ],
    },
    {
      kind: "fields",
      caption: t("osha.case.case"),
      fields: [
        { label: t("osha.case.items.10"), value: c.caseNumber },
        { label: t("osha.case.items.11"), value: day(c.injuryDate) },
        { label: t("osha.case.items.12"), value: v(c.workBeganAt?.slice(0, 5) ?? null) },
        {
          label: t("osha.case.items.13"),
          value: c.eventTimeUnknown
            ? t("osha.case.timeUnknown")
            : v(c.eventTime?.slice(0, 5) ?? null),
        },
        { label: t("osha.case.items.14"), value: v(c.activityBefore) },
        { label: t("osha.case.items.15"), value: v(c.whatHappened) },
        { label: t("osha.case.items.16"), value: v(c.injuryDetail) },
        { label: t("osha.case.items.17"), value: v(c.harmfulObject) },
        { label: t("osha.case.items.18"), value: day(c.diedOn) },
      ],
    },
    {
      kind: "fields",
      caption: t("osha.case.completed"),
      fields: [
        { label: t("osha.case.completedBy"), value: v(c.completedByName) },
        { label: t("osha.case.title"), value: v(c.completedTitle) },
        { label: t("osha.case.phone"), value: v(c.completedPhone) },
        { label: t("osha.case.date"), value: day(c.completedOn) },
      ],
    },
  ];
  return complianceModel({
    kind: "osha-301",
    locale: ctx.locale,
    messages: ctx.messages,
    title: t("osha.case.title301", { number: c.caseNumber, name: establishment.name }),
    recordKey: t("osha.case.key", { year: c.logYear, number: c.caseNumber }),
    recordUrl: ctx.recordUrl,
    brand: ctx.brand,
    blocks,
    watermark: ctx.watermark,
    ...(ctx.now ? { now: ctx.now } : {}),
  });
}
