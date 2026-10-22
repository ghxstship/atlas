import {
  certifiedPayrollCsv,
  certifiedPayrollModel,
  issueCertifiedPayroll,
} from "@xos/data/certified-payroll";
import { renderDocumentPdf } from "@xos/data/documents/render";
import { documentTranslator } from "@xos/data/documents/format";
import { loadDocumentBrand, watermarkText } from "@xos/data/documents/generate";
import { isPaper, type Paper } from "@xos/data/documents/model";
import {
  getOshaAnnualSummary,
  getOshaCase,
  getOshaEstablishment,
  getOshaTotals,
  listOshaCases,
  osha300Csv,
  osha300Model,
  osha300aCsv,
  osha300aModel,
  osha301Model,
} from "@xos/data/osha";
import { getMessages, isLocale } from "@xos/i18n";
import { getLocale } from "next-intl/server";
import { env } from "@/lib/env";
import type { OrgContext } from "@/lib/shell/context";

/**
 * The Section 14.5 compliance forms as files (ADR 0041): OSHA Forms 300, 300A and 301 and the WH-347
 * certified payroll, as tagged PDF/UA-1 with the Section 8.6 watermark or as CSV. Data is read with
 * the viewer's own row level security, so a form the viewer may not read answers 404, and the WH-347
 * is a Restricted export the database refuses without step-up authentication.
 */

export const COMPLIANCE_FORMS = ["osha-300", "osha-300a", "osha-301", "certified-payroll"] as const;
export type ComplianceForm = (typeof COMPLIANCE_FORMS)[number];

export function isComplianceForm(value: string): value is ComplianceForm {
  return (COMPLIANCE_FORMS as readonly string[]).includes(value);
}

export type FormFile =
  | {
      readonly ok: true;
      readonly body: Uint8Array | string;
      readonly type: string;
      readonly name: string;
    }
  | { readonly ok: false; readonly status: 400 | 403 | 404; readonly reason?: string };

export interface FormRequest {
  readonly form: ComplianceForm;
  readonly id: string;
  readonly format: "pdf" | "csv";
  readonly paper: Paper;
  readonly year?: number;
  readonly weekEnding?: string;
  readonly final?: boolean;
}

const YEAR = /^(20\d\d)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Reads the form's options from a query string or form body. */
export function formRequest(
  form: ComplianceForm,
  id: string,
  values: URLSearchParams,
): FormRequest | null {
  const format = values.get("format") === "csv" ? "csv" : "pdf";
  const paperValue = values.get("paper") ?? "letter";
  const base = { form, id, format, paper: isPaper(paperValue) ? paperValue : "letter" } as const;
  if (form === "osha-300" || form === "osha-300a") {
    const year = YEAR.exec(values.get("year") ?? "")?.[1];
    return year ? { ...base, year: Number(year) } : null;
  }
  if (form === "certified-payroll") {
    const week = values.get("week") ?? "";
    return DAY.test(week)
      ? { ...base, weekEnding: week, final: values.get("final") === "on" }
      : null;
  }
  return base;
}

const slug = (s: string) =>
  s
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

export async function complianceFormFile(ctx: OrgContext, request: FormRequest): Promise<FormFile> {
  const negotiated = await getLocale();
  const locale = isLocale(negotiated) ? negotiated : "en-US";
  const messages = getMessages(locale).documents;
  const t = documentTranslator(messages);
  const db = ctx.viewer.db;
  const site = env().ATLAS_SITE_URL;
  const now = new Date();
  const watermark = watermarkText(messages, locale, ctx.viewer.email ?? ctx.viewer.userId, now);
  const brand = () =>
    loadDocumentBrand(db, ctx.org.id, ctx.org.name, (name) => t("facts.logoAlt", { name }));
  const pdf = async (
    model: Parameters<typeof renderDocumentPdf>[0],
    landscape: boolean,
    name: string,
  ) => ({
    ok: true as const,
    body: await renderDocumentPdf(model, {
      paper: request.paper,
      orientation: landscape ? "landscape" : "portrait",
    }),
    type: "application/pdf",
    name: `${name}.pdf`,
  });
  const csv = (body: string, name: string) => ({
    ok: true as const,
    body,
    type: "text/csv; charset=utf-8",
    name: `${name}.csv`,
  });

  if (request.form === "certified-payroll") {
    const payroll = await issueCertifiedPayroll(db, {
      projectId: request.id,
      weekEnding: request.weekEnding ?? "",
      final: request.final === true,
    });
    if (!payroll.ok) {
      const rule = payroll.error.kind === "refusal" ? payroll.error.rule : undefined;
      if (rule) return { ok: false, status: 403, reason: rule };
      return { ok: false, status: payroll.error.kind === "not-found" ? 404 : 403 };
    }
    const name = `wh-347-${payroll.data.payrollNumber}-${slug(payroll.data.header.projectName)}-${payroll.data.weekEnding}`;
    if (request.format === "csv") return csv(certifiedPayrollCsv(payroll.data), name);
    return pdf(
      certifiedPayrollModel(payroll.data, {
        locale,
        messages,
        brand: await brand(),
        recordUrl: new URL(`/${ctx.org.slug}/settings/payroll-and-time-off`, site).toString(),
        watermark,
        certifyingOfficial: ctx.viewer.person?.fullName ?? ctx.viewer.email ?? "",
        now,
      }),
      true,
      name,
    );
  }

  const recordUrl = new URL(`/${ctx.org.slug}/settings/locations-and-venues`, site).toString();
  const formContext = async () => ({
    locale,
    messages,
    brand: await brand(),
    recordUrl,
    watermark,
    now,
  });

  if (request.form === "osha-301") {
    const found = await getOshaCase(db, request.id);
    if (!found.ok || !found.data) return { ok: false, status: 404 };
    const establishment = await getOshaEstablishment(db, found.data.establishmentId);
    if (!establishment.ok || !establishment.data) return { ok: false, status: 404 };
    return pdf(
      osha301Model(establishment.data, found.data, await formContext()),
      false,
      `osha-301-${found.data.logYear}-${found.data.caseNumber}`,
    );
  }

  const establishment = await getOshaEstablishment(db, request.id);
  if (!establishment.ok || !establishment.data) return { ok: false, status: 404 };
  const year = request.year ?? now.getUTCFullYear();
  const name = `${request.form}-${year}-${slug(establishment.data.name)}`;
  if (request.form === "osha-300") {
    const cases = await listOshaCases(db, { establishmentId: request.id, year });
    if (!cases.ok) return { ok: false, status: 404 };
    // Cases are health information: without the medical capability the log is not shown at all.
    if (!ctx.capabilities.has("data.restricted.read.medical")) return { ok: false, status: 404 };
    if (request.format === "csv") return csv(osha300Csv(cases.data), name);
    return pdf(osha300Model(establishment.data, year, cases.data, await formContext()), true, name);
  }
  const [totals, summary] = await Promise.all([
    getOshaTotals(db, request.id, year),
    getOshaAnnualSummary(db, request.id, year),
  ]);
  if (!totals.ok || !summary.ok) return { ok: false, status: 404 };
  if (request.format === "csv") {
    return csv(osha300aCsv(establishment.data, year, totals.data, summary.data), name);
  }
  return pdf(
    osha300aModel(establishment.data, year, totals.data, summary.data, await formContext()),
    false,
    name,
  );
}

export function fileResponse(file: Extract<FormFile, { ok: true }>): Response {
  return new Response(file.body as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": file.type,
      "Content-Disposition": `attachment; filename="${file.name}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
