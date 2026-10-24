"use server";

import { saveCertifiedPayrollHeader } from "@xos/data/certified-payroll";
import {
  OSHA_CASE_TYPES,
  OSHA_OUTCOMES,
  createOshaEstablishment,
  saveOshaAnnualSummary,
  saveOshaCase,
} from "@xos/data/osha";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { usComplianceFormsOn } from "@/lib/compliance/flag";
import { errorKey, type ActionState } from "@/lib/operations/state";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Section 14.5 compliance records (ADR 0041): OSHA establishments, cases and annual summaries
 * (migration 1385) and the WH-347 project header (1386). Each action runs as the signed-in person in
 * the org named by the form; row level security decides every write and refusals come back by rule.
 * While the org has the compliance.us_forms flag off (ADR 0033 decision 54), each answers notFound,
 * as for an org the person cannot open, and the database refuses the write on its own.
 */

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v));
const optionalDate = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .refine((v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v));
const optionalTime = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .refine((v) => v === null || /^\d{2}:\d{2}$/.test(v));
const state = z
  .string()
  .trim()
  .toUpperCase()
  .transform((v) => (v === "" ? null : v))
  .refine((v) => v === null || /^[A-Z]{2}$/.test(v));
const zip = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .refine((v) => v === null || /^\d{5}(-\d{4})?$/.test(v));
const yesNo = z
  .string()
  .optional()
  .transform((v) => (v === "yes" ? true : v === "no" ? false : null));

function fields(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of form) if (typeof value === "string") out[key] = value;
  return out;
}

/** The org the form names, or null when there is none or it has the forms off (compliance.us_forms, 1593). */
async function context(form: FormData) {
  const ctx = await getOrgContext(String(form.get("org") ?? ""));
  return ctx && (await usComplianceFormsOn(ctx)) ? ctx : null;
}

const Establishment = z.object({
  name: z.string().trim().min(1).max(200),
  street: optional(200),
  city: optional(100),
  state,
  zip,
  naics: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : v))
    .refine((v) => v === null || /^\d{2,6}$/.test(v)),
  industry: optional(200),
});

export async function createEstablishmentAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await context(form);
  if (!ctx) return { error: "notFound" };
  const input = Establishment.safeParse(fields(form));
  if (!input.success) return { error: "invalid" };
  const saved = await createOshaEstablishment(ctx.viewer.db, {
    orgId: ctx.org.id,
    name: input.data.name,
    streetAddress: input.data.street,
    locality: input.data.city,
    regionCode: input.data.state,
    postalCode: input.data.zip,
    naicsCode: input.data.naics,
    industryDescription: input.data.industry,
  });
  if (!saved.ok) return { error: errorKey(saved.error) };
  revalidatePath(`/${ctx.org.slug}/settings/locations-and-venues`);
  return { ok: true, result: { name: input.data.name } };
}

const count = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : Number(v)))
  .refine((v) => v === null || (Number.isInteger(v) && v >= 0));

const Summary = z.object({
  establishment: z.uuid(),
  year: z.coerce.number().int().min(2000).max(2200),
  employees: count,
  hours: count,
  title: optional(100),
  phone: optional(30),
  certify: z.string().optional(),
});

export async function saveOshaSummaryAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await context(form);
  if (!ctx) return { error: "notFound" };
  const input = Summary.safeParse(fields(form));
  if (!input.success) return { error: "invalid" };
  const certify = input.data.certify === "on" && ctx.viewer.person !== null;
  const saved = await saveOshaAnnualSummary(ctx.viewer.db, {
    establishmentId: input.data.establishment,
    year: input.data.year,
    annualAverageEmployees: input.data.employees,
    totalHoursWorked: input.data.hours,
    certifiedBy: certify ? (ctx.viewer.person?.id ?? null) : null,
    certifierTitle: input.data.title,
    certifierPhone: input.data.phone,
    certifiedOn: certify ? new Date().toISOString().slice(0, 10) : null,
  });
  if (!saved.ok) return { error: errorKey(saved.error) };
  revalidatePath(`/${ctx.org.slug}/settings/locations-and-venues`);
  return { ok: true, result: { year: String(input.data.year) } };
}

const Case = z.object({
  incident: z.uuid(),
  establishment: z.uuid(),
  person: z.string().optional(),
  employeeName: optional(200),
  privacy: z.string().optional(),
  jobTitle: z.string().trim().min(1).max(100),
  injuryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  eventLocation: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(500),
  outcome: z.enum(OSHA_OUTCOMES),
  daysAway: count,
  daysRestricted: count,
  caseType: z.enum(OSHA_CASE_TYPES),
  employeeStreet: optional(200),
  employeeCity: optional(100),
  employeeState: state,
  employeeZip: zip,
  dateOfBirth: optionalDate,
  dateHired: optionalDate,
  sex: z
    .string()
    .optional()
    .transform((v) => (v === "Male" || v === "Female" ? v : null)),
  professional: optional(200),
  facility: optional(200),
  facilityStreet: optional(200),
  facilityCity: optional(100),
  facilityState: state,
  facilityZip: zip,
  emergencyRoom: yesNo,
  hospitalized: yesNo,
  workBegan: optionalTime,
  eventTime: optionalTime,
  timeUnknown: z.string().optional(),
  activityBefore: optional(2000),
  whatHappened: optional(2000),
  injuryDetail: optional(2000),
  harmfulObject: optional(500),
  diedOn: optionalDate,
  completedTitle: optional(100),
  completedPhone: optional(30),
});

export async function recordOshaCaseAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await context(form);
  if (!ctx) return { error: "notFound" };
  const input = Case.safeParse(fields(form));
  if (!input.success) return { error: "invalid" };
  const d = input.data;
  const person = d.person && z.uuid().safeParse(d.person).success ? d.person : null;
  if (!person && !d.employeeName) return { error: "invalid" };
  const saved = await saveOshaCase(ctx.viewer.db, {
    establishment_id: d.establishment,
    incident_id: d.incident,
    person_id: person,
    employee_name: person ? null : d.employeeName,
    privacy_case: d.privacy === "on",
    job_title: d.jobTitle,
    injury_date: d.injuryDate,
    event_location: d.eventLocation,
    description: d.description,
    outcome: d.outcome,
    days_away: d.daysAway ?? 0,
    days_restricted: d.daysRestricted ?? 0,
    case_type: d.caseType,
    employee_street: d.employeeStreet,
    employee_locality: d.employeeCity,
    employee_region: d.employeeState,
    employee_postal_code: d.employeeZip,
    date_of_birth: d.dateOfBirth,
    date_hired: d.dateHired,
    employee_sex: d.sex,
    health_care_professional: d.professional,
    treatment_facility: d.facility,
    facility_street: d.facilityStreet,
    facility_locality: d.facilityCity,
    facility_region: d.facilityState,
    facility_postal_code: d.facilityZip,
    emergency_room: d.emergencyRoom,
    hospitalized_overnight: d.hospitalized,
    work_began_at: d.workBegan,
    event_time: d.timeUnknown === "on" ? null : d.eventTime,
    event_time_unknown: d.timeUnknown === "on",
    activity_before: d.activityBefore,
    what_happened: d.whatHappened,
    injury_detail: d.injuryDetail,
    harmful_object: d.harmfulObject,
    died_on: d.diedOn,
    completed_by: ctx.viewer.person?.id ?? null,
    completed_title: d.completedTitle,
    completed_phone: d.completedPhone,
    completed_on: new Date().toISOString().slice(0, 10),
  });
  if (!saved.ok) return { error: errorKey(saved.error) };
  revalidatePath(`/${ctx.org.slug}/safety/incidents`);
  return { ok: true };
}

const Header = z.object({
  project: z.uuid(),
  contractNumber: z.string().trim().min(1).max(100),
  wageDeterminations: z.string().trim().min(1).max(500),
  contractorRole: z.enum(["Prime contractor", "Subcontractor"]),
  businessName: z.string().trim().min(1).max(200),
  businessAddress: z.string().trim().min(1).max(300),
  projectLocation: z.string().trim().min(1).max(300),
});

export async function saveCertifiedPayrollHeaderAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await context(form);
  if (!ctx) return { error: "notFound" };
  const input = Header.safeParse(fields(form));
  if (!input.success) return { error: "invalid" };
  const saved = await saveCertifiedPayrollHeader(ctx.viewer.db, {
    projectId: input.data.project,
    contractNumber: input.data.contractNumber,
    wageDeterminations: input.data.wageDeterminations,
    contractorRole: input.data.contractorRole,
    businessName: input.data.businessName,
    businessAddress: input.data.businessAddress,
    projectLocation: input.data.projectLocation,
  });
  if (!saved.ok) return { error: errorKey(saved.error) };
  revalidatePath(`/${ctx.org.slug}/settings/payroll-and-time-off`);
  return { ok: true };
}
