import { getTranslations } from "next-intl/server";
import { usComplianceFormsOn } from "@/lib/compliance/flag";
import {
  complianceFormFile,
  fileResponse,
  formRequest,
  isComplianceForm,
} from "@/lib/compliance/forms";
import { getOrgContext } from "@/lib/shell/context";

/**
 * A Section 14.5 compliance form as a file (ADR 0041): OSHA Forms 300 and 300A of an establishment
 * (`?year=`), Form 301 of a case, as PDF/UA-1 or `?format=csv`. The WH-347 certified payroll numbers
 * the week it issues, so it is a POST from Settings, Payroll and Time Off, never a link. Everything is
 * read as the viewer; anything they may not read is 404, and a database refusal (the WH-347 needs
 * the restricted export capability and step-up authentication) is 403 with its rule. An org with
 * the compliance.us_forms flag off (ADR 0033 decision 54, migration 1593) has no forms: 404.
 */
async function serve(
  form: string,
  org: string,
  id: string,
  values: URLSearchParams,
  method: "GET" | "POST",
): Promise<Response> {
  if (!isComplianceForm(form)) return new Response(null, { status: 404 });
  if ((form === "certified-payroll") !== (method === "POST"))
    return new Response(null, { status: 405 });
  const ctx = await getOrgContext(org);
  if (!ctx || !(await usComplianceFormsOn(ctx))) return new Response(null, { status: 404 });
  const request = formRequest(form, id, values);
  if (!request) return new Response(null, { status: 400 });
  const file = await complianceFormFile(ctx, request);
  if (!file.ok) {
    const t = (await getTranslations("compliance.wh347")) as unknown as {
      (key: string): string;
      has(key: string): boolean;
    };
    const known = file.reason && t.has(`refusals.${file.reason}`);
    const body = file.status === 403 ? t(known ? `refusals.${file.reason}` : "refused") : null;
    return new Response(body, {
      status: file.status,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return fileResponse(file);
}

export async function GET(
  request: Request,
  { params }: RouteContext<"/[org]/forms/[form]/[id]">,
): Promise<Response> {
  const { org, form, id } = await params;
  return serve(form, org, id, new URL(request.url).searchParams, "GET");
}

export async function POST(
  request: Request,
  { params }: RouteContext<"/[org]/forms/[form]/[id]">,
): Promise<Response> {
  const { org, form, id } = await params;
  const body = await request.formData();
  const values = new URLSearchParams();
  for (const [key, value] of body) if (typeof value === "string") values.set(key, value);
  return serve(form, org, id, values, "POST");
}
