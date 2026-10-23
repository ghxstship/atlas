import type { XosClient } from "./client.ts";
import { complianceModel, complianceTools, toCsvFile } from "./documents/compliance.ts";
import type { DocumentBlock, DocumentModel } from "./documents/model.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * The WH-347 certified payroll (Davis-Bacon and Related Acts; Section 14.5, finding A65-014;
 * migration 1386) as tagged PDF/UA-1 (ADR 0031) and CSV. The columns follow Form WH-347, Rev. January
 * 2025 (OMB 1235-0008) and its instructions; ADR 0041 maps each one to its source. XOS holds no
 * fringe benefit credits, payments in lieu, deductions or net pay (columns 6B, 6C, 8 and 9): the
 * payroll provider does, so those columns stay empty and the form says so. A Restricted export: the
 * database asks for the restricted export capability and step-up authentication and audits it.
 */

export interface CertifiedPayrollHeader {
  readonly projectId: string;
  readonly projectName: string;
  readonly contractNumber: string;
  readonly wageDeterminations: string;
  readonly contractorRole: "Prime contractor" | "Subcontractor";
  readonly businessName: string;
  readonly businessAddress: string;
  readonly projectLocation: string;
}

export interface CertifiedPayrollRow {
  readonly entryNumber: number;
  readonly lastName: string;
  readonly firstName: string;
  readonly middleInitial: string | null;
  readonly identifyingNumber: string;
  /** J, or RA with the progression level. */
  readonly apprentice: string;
  readonly laborClassification: string;
  /** Minutes per day, the first day of the week first. */
  readonly straightMinutes: readonly number[];
  readonly overtimeMinutes: readonly number[];
  readonly totalMinutes: number;
  readonly currency: string;
  readonly straightRateMinor: number | null;
  readonly overtimeRateMinor: number | null;
  readonly grossProjectMinor: number;
  readonly grossAllWorkMinor: number;
}

export interface CertifiedPayroll {
  readonly header: CertifiedPayrollHeader;
  readonly weekEnding: string;
  readonly payrollNumber: number;
  readonly finalSubmission: boolean;
  readonly rows: readonly CertifiedPayrollRow[];
}

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const minutes = (v: unknown): number[] =>
  Array.isArray(v) ? v.map((m) => Number(m ?? 0)) : [0, 0, 0, 0, 0, 0, 0];

type Query = PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }> & {
  eq(column: string, value: unknown): Query;
  is(column: string, value: null): Query;
  maybeSingle(): Query;
};

function select(db: XosClient, table: string, columns: string): Query {
  return (db as unknown as { from(t: string): { select(c: string): Query } })
    .from(table)
    .select(columns);
}

export async function getCertifiedPayrollHeader(
  db: XosClient,
  projectId: string,
): Promise<Result<CertifiedPayrollHeader | null>> {
  const { data, error } = await select(
    db,
    "certified_payroll_projects",
    "project_id, contract_number, wage_determinations, contractor_role, business_name, business_address, project_location, project:projects!certified_payroll_projects_project_id_fkey(name)",
  )
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return ok(null);
  const r = data as Record<string, unknown>;
  return ok({
    projectId: String(r["project_id"]),
    projectName: text((r["project"] as Record<string, unknown> | null)?.["name"]) ?? "",
    contractNumber: String(r["contract_number"]),
    wageDeterminations: String(r["wage_determinations"]),
    contractorRole: r["contractor_role"] === "Subcontractor" ? "Subcontractor" : "Prime contractor",
    businessName: String(r["business_name"]),
    businessAddress: String(r["business_address"]),
    projectLocation: String(r["project_location"]),
  });
}

export interface CertifiedPayrollHeaderInput {
  readonly projectId: string;
  readonly contractNumber: string;
  readonly wageDeterminations: string;
  readonly contractorRole: "Prime contractor" | "Subcontractor";
  readonly businessName: string;
  readonly businessAddress: string;
  readonly projectLocation: string;
}

/** Saves a project's WH-347 header, creating it the first time. */
export async function saveCertifiedPayrollHeader(
  db: XosClient,
  input: CertifiedPayrollHeaderInput,
): Promise<Result<true>> {
  const row = {
    contract_number: input.contractNumber,
    wage_determinations: input.wageDeterminations,
    contractor_role: input.contractorRole,
    business_name: input.businessName,
    business_address: input.businessAddress,
    project_location: input.projectLocation,
  };
  const table = (
    db as unknown as {
      from(t: string): {
        update(r: object): {
          eq(
            c: string,
            v: string,
          ): {
            is(
              c: string,
              v: null,
            ): {
              select(c: string): PromiseLike<{ data: unknown[] | null; error: never }>;
            };
          };
        };
        insert(r: object): PromiseLike<{ error: never }>;
      };
    }
  ).from("certified_payroll_projects");
  const updated = await table
    .update(row)
    .eq("project_id", input.projectId)
    .is("deleted_at", null)
    .select("id");
  if (updated.error) return fail(toDataError(updated.error));
  if ((updated.data ?? []).length > 0) return ok(true);
  const inserted = await table.insert({ project_id: input.projectId, ...row });
  if (inserted.error) return fail(toDataError(inserted.error));
  return ok(true);
}

/** The week's certified payroll: numbers the week and reads the rows (a Restricted export). */
export async function issueCertifiedPayroll(
  db: XosClient,
  input: { readonly projectId: string; readonly weekEnding: string; readonly final: boolean },
): Promise<Result<CertifiedPayroll>> {
  const header = await getCertifiedPayrollHeader(db, input.projectId);
  if (!header.ok) return header;
  const { data, error } = await db.rpc("certified_payroll", {
    p_project_id: input.projectId,
    p_week_ending: input.weekEnding,
    p_final: input.final,
  });
  if (error) return fail(toDataError(error));
  if (!header.data) return fail({ kind: "not-found" });
  const submission = await select(
    db,
    "certified_payroll_submissions",
    "payroll_number, final_submission",
  )
    .eq("project_id", input.projectId)
    .eq("week_ending", input.weekEnding)
    .is("deleted_at", null)
    .maybeSingle();
  if (submission.error) return fail(toDataError(submission.error));
  const s = (submission.data ?? {}) as Record<string, unknown>;
  return ok({
    header: header.data,
    weekEnding: input.weekEnding,
    payrollNumber: Number(s["payroll_number"] ?? 0),
    finalSubmission: s["final_submission"] === true,
    rows: ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
      entryNumber: Number(r["entry_number"]),
      lastName: String(r["last_name"] ?? ""),
      firstName: String(r["first_name"] ?? ""),
      middleInitial: text(r["middle_initial"]),
      identifyingNumber: String(r["identifying_number"] ?? ""),
      apprentice: String(r["apprentice"] ?? "J"),
      laborClassification: String(r["labor_classification"] ?? ""),
      straightMinutes: minutes(r["straight_minutes"]),
      overtimeMinutes: minutes(r["overtime_minutes"]),
      totalMinutes: Number(r["total_minutes"] ?? 0),
      currency: String(r["currency_code"] ?? "USD"),
      straightRateMinor:
        (r["straight_rate_minor"] ?? null) === null ? null : Number(r["straight_rate_minor"]),
      overtimeRateMinor:
        (r["overtime_rate_minor"] ?? null) === null ? null : Number(r["overtime_rate_minor"]),
      grossProjectMinor: Number(r["gross_project_minor"] ?? 0),
      grossAllWorkMinor: Number(r["gross_all_work_minor"] ?? 0),
    })),
  });
}

/** The seven dates of the week ending on `weekEnding` (YYYY-MM-DD), first day first. */
export function weekDates(weekEnding: string): string[] {
  const end = Date.parse(`${weekEnding}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) =>
    new Date(end - (6 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

const hours = (m: number): string => (m / 60).toFixed(2);
const money = (minor: number | null): string => (minor === null ? "" : (minor / 100).toFixed(2));

/**
 * The WH-347 page 1 as CSV: one row per worker and classification with straight and overtime hours
 * of each day side by side. The columns XOS does not hold (6B, 6C, 8, 9) are present and empty.
 */
export function certifiedPayrollCsv(payroll: CertifiedPayroll): string {
  const days = weekDates(payroll.weekEnding);
  const h = payroll.header;
  return toCsvFile(
    [
      "Project name",
      "Project No. or Contract No.",
      "Certified Payroll No.",
      "Prime contractor or subcontractor",
      "Business name",
      "Business address",
      "Project location",
      "Wage determination no.",
      "Week ending date",
      "Final submission",
      "(1A) Worker entry no.",
      "(1B) Worker last name",
      "(1C) Worker first name",
      "(1D) Worker middle initial",
      "(1E) Worker identifying no.",
      "(2) J or RA",
      "(3) Labor classification",
      ...days.map((d) => `(4) ST ${d}`),
      ...days.map((d) => `(4) OT ${d}`),
      "(5) Total hours worked for week",
      "(6A) Hourly wage rate ST",
      "(6A) Hourly wage rate OT",
      "(6B) Total fringe benefit credit",
      "(6C) Payment in lieu of fringe benefits",
      "(7A) Gross amount earned",
      "(7B) Gross amount earned for all work",
      "(8) Tax withholdings",
      "(8) FICA",
      "(8) Other",
      "(8) Total deductions",
      "(9) Net pay for all work",
    ],
    payroll.rows.map((r) => [
      h.projectName,
      h.contractNumber,
      String(payroll.payrollNumber),
      h.contractorRole,
      h.businessName,
      h.businessAddress,
      h.projectLocation,
      h.wageDeterminations,
      payroll.weekEnding,
      payroll.finalSubmission ? "Yes" : "No",
      String(r.entryNumber),
      r.lastName,
      r.firstName,
      r.middleInitial ?? "",
      r.identifyingNumber,
      r.apprentice,
      r.laborClassification,
      ...r.straightMinutes.map(hours),
      ...r.overtimeMinutes.map(hours),
      hours(r.totalMinutes),
      money(r.straightRateMinor),
      money(r.overtimeRateMinor),
      "",
      "",
      money(r.grossProjectMinor),
      money(r.grossAllWorkMinor),
      "",
      "",
      "",
      "",
      "",
    ]),
  );
}

export interface CertifiedPayrollContext {
  readonly locale: string;
  /** The `documents` namespace of the caller's catalog. */
  readonly messages: unknown;
  readonly brand: DocumentModel["brand"];
  readonly recordUrl: string;
  readonly watermark: string;
  /** The person issuing it, printed as the certifying official. */
  readonly certifyingOfficial: string;
  readonly now?: Date;
}

/** The WH-347, both pages: the weekly payroll and the Statement of Compliance. */
export function certifiedPayrollModel(
  payroll: CertifiedPayroll,
  ctx: CertifiedPayrollContext,
): DocumentModel {
  const { t, f } = complianceTools(ctx.messages, ctx.locale);
  const h = payroll.header;
  const days = weekDates(payroll.weekEnding);
  const weekday = new Intl.DateTimeFormat(ctx.locale, { weekday: "short", timeZone: "UTC" });
  const dayLabel = (d: string) =>
    `${weekday.format(new Date(`${d}T00:00:00Z`))} ${d.slice(5).replace("-", "/")}`;
  const cash = (minor: number | null, currency: string) =>
    minor === null ? t("common.none") : f.money(minor, currency);
  const rows: string[][] = [];
  for (const r of payroll.rows) {
    const name = [r.lastName, [r.firstName, r.middleInitial].filter(Boolean).join(" ")]
      .filter(Boolean)
      .join(", ");
    rows.push([
      String(r.entryNumber),
      name,
      r.identifyingNumber,
      r.apprentice,
      r.laborClassification,
      t("wh347.st"),
      ...r.straightMinutes.map(hours),
      hours(r.totalMinutes),
      cash(r.straightRateMinor, r.currency),
      f.money(r.grossProjectMinor, r.currency),
      f.money(r.grossAllWorkMinor, r.currency),
    ]);
    rows.push([
      String(r.entryNumber),
      name,
      "",
      "",
      "",
      t("wh347.ot"),
      ...r.overtimeMinutes.map(hours),
      "",
      cash(r.overtimeRateMinor, r.currency),
      "",
      "",
    ]);
  }
  const blocks: DocumentBlock[] = [
    {
      kind: "fields",
      caption: t("wh347.header"),
      fields: [
        { label: t("wh347.projectName"), value: h.projectName },
        { label: t("wh347.contractNumber"), value: h.contractNumber },
        { label: t("wh347.payrollNumber"), value: String(payroll.payrollNumber) },
        { label: t("wh347.contractor"), value: t(`wh347.roles.${h.contractorRole}`) },
        { label: t("wh347.businessName"), value: h.businessName },
        { label: t("wh347.businessAddress"), value: h.businessAddress },
        { label: t("wh347.projectLocation"), value: h.projectLocation },
        { label: t("wh347.wageDeterminations"), value: h.wageDeterminations },
        { label: t("wh347.weekEnding"), value: f.day(payroll.weekEnding) },
        {
          label: t("wh347.final"),
          value: t(payroll.finalSubmission ? "wh347.yes" : "wh347.no"),
        },
      ],
    },
    {
      kind: "table",
      caption: t("wh347.caption"),
      columns: [
        { label: t("wh347.columns.entry"), weight: 0.5 },
        { label: t("wh347.columns.name"), weight: 1.6 },
        { label: t("wh347.columns.identifying"), weight: 1 },
        { label: t("wh347.columns.apprentice"), weight: 0.6 },
        { label: t("wh347.columns.classification"), weight: 1.5 },
        { label: t("wh347.columns.type"), weight: 0.5 },
        ...days.map((d) => ({ label: dayLabel(d), numeric: true, weight: 0.7 })),
        { label: t("wh347.columns.total"), numeric: true, weight: 0.8 },
        { label: t("wh347.columns.rate"), numeric: true, weight: 1 },
        { label: t("wh347.columns.gross"), numeric: true, weight: 1.1 },
        { label: t("wh347.columns.grossAll"), numeric: true, weight: 1.1 },
      ],
      rows,
      empty: t("wh347.empty"),
    },
    { kind: "paragraph", text: t("wh347.provider") },
    { kind: "heading", text: t("wh347.statement.heading") },
    {
      kind: "fields",
      caption: t("wh347.statement.official"),
      fields: [
        { label: t("wh347.statement.name"), value: ctx.certifyingOfficial },
        {
          label: t("wh347.statement.date"),
          value: f.day((ctx.now ?? new Date()).toISOString().slice(0, 10)),
        },
      ],
    },
    { kind: "paragraph", text: t("wh347.statement.paid") },
    { kind: "paragraph", text: t("wh347.statement.correct") },
    { kind: "paragraph", text: t("wh347.statement.records") },
    { kind: "paragraph", text: t("wh347.statement.classifications") },
    { kind: "paragraph", text: t("wh347.statement.apprentices") },
    { kind: "paragraph", text: t("wh347.statement.fringe") },
    { kind: "paragraph", text: t("wh347.statement.wages") },
    { kind: "paragraph", text: t("wh347.statement.warning") },
  ];
  return complianceModel({
    kind: "certified-payroll",
    locale: ctx.locale,
    messages: ctx.messages,
    title: t("wh347.title", { project: h.projectName, number: payroll.payrollNumber }),
    recordKey: t("wh347.key", { number: payroll.payrollNumber, week: payroll.weekEnding }),
    recordUrl: ctx.recordUrl,
    brand: ctx.brand,
    blocks,
    watermark: ctx.watermark,
    ...(ctx.now ? { now: ctx.now } : {}),
  });
}
