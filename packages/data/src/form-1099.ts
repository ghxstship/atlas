import type { XosClient } from "./client.ts";
import { toCsv } from "./finance.ts";
import { external } from "./gateway-external.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * The 1099-NEC data export (A43, finding A38-006; Section 4.4.5 year-end, Section 14.9). The rows come
 * from app.form_1099_nec_rows (migration 1124): per payee, the approved USD payments of a calendar year
 * to people and accounts engaged as independent contractors, from $600, with the W-9 on file. Without
 * the TIN they need finance.payment.read; with it they are a Restricted export (data.export.restricted
 * and step-up authentication) that the database writes to the audit log.
 *
 * The file follows the field layout of the IRS FIRE "B" (payee) record of Publication 1220 for Form
 * 1099-NEC, one CSV column per field, so it can be keyed or converted into the fixed-width FIRE file by
 * the org's filing software. Amounts are cents, right-justified and zero-filled to 12 digits as the
 * record requires; ZIP codes are digits only.
 */

/** Payments at or above this, in USD minor units, are reportable on Form 1099-NEC. */
export const FORM_1099_NEC_THRESHOLD_MINOR = 60_000;

export interface Form1099NecRow {
  readonly payeePersonId: string | null;
  readonly payeeOrganizationId: string | null;
  readonly payeeName: string;
  readonly taxFormId: string | null;
  readonly w9OnFile: boolean;
  /** 1 for an EIN (an account), 2 for an SSN (a person), as FIRE codes them; null without a W-9. */
  readonly tinType: 1 | 2 | null;
  readonly tinLast4: string | null;
  /** The full TIN, only in the Restricted export. */
  readonly tin: string | null;
  readonly streetAddress: string | null;
  readonly locality: string | null;
  readonly regionCode: string | null;
  readonly postalCode: string | null;
  readonly addressComplete: boolean;
  readonly amountMinor: number;
  readonly paymentCount: number;
}

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export async function listForm1099NecRows(
  db: XosClient,
  input: { readonly orgId: string; readonly year: number; readonly includeTin?: boolean },
): Promise<Result<Form1099NecRow[]>> {
  const { data, error } = await db.rpc("form_1099_nec_rows", {
    p_org_id: input.orgId,
    p_year: input.year,
    p_include_tin: input.includeTin === true,
  });
  if (error) return fail(toDataError(error));
  return ok(
    ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
      payeePersonId: text(r["payee_person_id"]),
      payeeOrganizationId: text(r["payee_organization_id"]),
      payeeName: text(r["payee_name"]) ?? "",
      taxFormId: text(r["tax_form_id"]),
      w9OnFile: r["w9_on_file"] === true,
      tinType: r["tin_type"] === 1 ? 1 : r["tin_type"] === 2 ? 2 : null,
      tinLast4: text(r["tin_last4"]),
      tin: text(r["tin"]),
      streetAddress: text(r["street_address"]),
      locality: text(r["locality"]),
      regionCode: text(r["region_code"]),
      postalCode: text(r["postal_code"]),
      addressComplete: r["address_complete"] === true,
      amountMinor: Number(r["amount_minor"] ?? 0),
      paymentCount: Number(r["payment_count"] ?? 0),
    })),
  );
}

/** FIRE B record fields for Form 1099-NEC, in record order (Publication 1220). */
export const FIRE_1099_NEC_COLUMNS = [
  "Record Type",
  "Payment Year",
  "Type of Return",
  "Amount Codes",
  "Type of TIN",
  "Payee's TIN",
  "Payer's Account Number for Payee",
  "Payment Amount 1",
  "Foreign Country Indicator",
  "First Payee Name Line",
  "Second Payee Name Line",
  "Payee Mailing Address",
  "Payee City",
  "Payee State",
  "Payee ZIP Code",
  "Second TIN Notice",
  "Direct Sales Indicator",
  "FATCA Filing Requirement Indicator",
] as const;

/** A row is fileable with a W-9, its full TIN and a complete address. */
export function fileable(row: Form1099NecRow): boolean {
  return row.w9OnFile && row.tin !== null && row.tinType !== null && row.addressComplete;
}

/** Cents, right-justified and zero-filled to the record's 12 digits. */
export function fireAmount(minor: number): string {
  return String(Math.max(0, Math.round(minor))).padStart(12, "0");
}

/** The payer's 20-character account number for a payee: its id without dashes. */
export function payeeAccountNumber(row: Form1099NecRow): string {
  return (row.payeePersonId ?? row.payeeOrganizationId ?? "").replace(/-/g, "").slice(0, 20);
}

/**
 * The CSV of the fileable rows in FIRE field order, and the rows left out because a W-9 or its
 * address is missing, so the page can name who to chase before filing.
 */
export function form1099NecCsv(
  rows: readonly Form1099NecRow[],
  year: number,
): { readonly csv: string; readonly filed: number; readonly missing: readonly Form1099NecRow[] } {
  const ready = rows.filter(fileable);
  const body = ready.map((r) => [
    "B",
    String(year),
    "NE",
    "1",
    String(r.tinType),
    (r.tin ?? "").replace(/[^0-9]/g, ""),
    payeeAccountNumber(r),
    fireAmount(r.amountMinor),
    "",
    r.payeeName.slice(0, 40),
    "",
    (r.streetAddress ?? "").slice(0, 40),
    (r.locality ?? "").slice(0, 40),
    r.regionCode ?? "",
    (r.postalCode ?? "").replace(/[^0-9]/g, "").slice(0, 9),
    "",
    "",
    "",
  ]);
  return {
    csv: toCsv(FIRE_1099_NEC_COLUMNS, body),
    filed: ready.length,
    missing: rows.filter((r) => !fileable(r)),
  };
}

// The payee's side: the name and mailing address on its W-9 ------------------------------------------

export interface W9Address {
  readonly taxFormId: string;
  readonly orgName: string;
  readonly tinLast4: string;
  readonly legalName: string | null;
  readonly streetAddress: string | null;
  readonly locality: string | null;
  readonly regionCode: string | null;
  readonly postalCode: string | null;
  readonly complete: boolean;
}

/** The caller's W-9s (their own, and their account's) with the address the 1099-NEC needs. */
export async function listW9Addresses(db: XosClient): Promise<Result<W9Address[]>> {
  const { data, error } = await external(db)
    .from("tax_forms")
    .select(
      "id, org_name, tin_last4, form_kind, legal_name, street_address, locality, region_code, postal_code",
    )
    .eq("form_kind", "W-9")
    .order("signed_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      taxFormId: r.id ?? "",
      orgName: r.org_name ?? "",
      tinLast4: r.tin_last4 ?? "",
      legalName: r.legal_name,
      streetAddress: r.street_address,
      locality: r.locality,
      regionCode: r.region_code,
      postalCode: r.postal_code,
      complete:
        r.street_address !== null &&
        r.locality !== null &&
        r.region_code !== null &&
        r.postal_code !== null,
    })),
  );
}

/** The payee records the name and mailing address on its tax form (app.set_tax_form_address). */
export async function setTaxFormAddress(
  db: XosClient,
  input: {
    readonly taxFormId: string;
    readonly legalName: string | null;
    readonly streetAddress: string;
    readonly locality: string;
    readonly regionCode: string;
    readonly postalCode: string;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("set_tax_form_address", {
    p_tax_form_id: input.taxFormId,
    p_legal_name: input.legalName ?? "",
    p_street_address: input.streetAddress,
    p_locality: input.locality,
    p_region_code: input.regionCode,
    p_postal_code: input.postalCode,
  });
  if (error) return fail(toDataError(error));
  return ok({ id: String(data) });
}
