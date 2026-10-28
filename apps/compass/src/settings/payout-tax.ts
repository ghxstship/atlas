/**
 * Settings, Payout and Tax in Compass (Section 4.5.6 personal item 11, Section 4.4.5, ADR 0072): where each org pays
 * the person and the tax forms they gave, read with Gateway's own functions (listPayoutAccounts, listTaxForms and
 * listW9Addresses over the api_external projections), so only the last four characters of an account or identifier
 * ever reach the phone. Like Gateway's section, it lists the person's own rows, not a company account's.
 *
 * The one entry step Compass draws is the W-9 name and mailing address the 1099-NEC export needs (A43, 1124): the
 * payee's own app.set_tax_form_address, which sets the same values however often it runs, so it queues offline.
 * Giving a tax form belongs to the onboarding of the engagement that asks for it, and Compass has no engagement
 * screen, so that step opens Gateway. Payout details are entered through each org's payment provider; XOS never
 * holds them. No step of this section needs step-up.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { XosClient } from "@xos/data/client";
import { listW9Addresses } from "@xos/data/form-1099";
import { listPayoutAccounts, listTaxForms } from "@xos/data/gateway";
import type { MutationInput, Row } from "@xos/sync";
import { enumKey } from "../domain/external";

/** The device-local copies of the person's payout destinations and tax forms. */
export const PAYOUT_TAX_MIRROR = {
  payouts: "_me_payout_accounts",
  taxForms: "_me_tax_forms",
} as const;

/** A payout destination as the device keeps it: the paying org, the provider and the last four only. */
export interface PayoutRow extends Row {
  readonly orgId: string;
  readonly provider: string;
  readonly last4: string | null;
}

/** A tax form as the device keeps it, with the W-9 name and address when it is a W-9. */
export interface TaxFormRow extends Row {
  readonly orgId: string;
  readonly orgName: string;
  readonly kind: string;
  readonly tinLast4: string;
  readonly withholding: boolean;
  readonly signedAt: string;
  readonly legalName: string | null;
  readonly streetAddress: string | null;
  readonly locality: string | null;
  readonly regionCode: string | null;
  readonly postalCode: string | null;
}

/** The person's own payout destinations (api_external.payout_accounts), or null when the read failed. */
export async function readMyPayouts(
  client: SupabaseClient,
  personId: string,
): Promise<PayoutRow[] | null> {
  const result = await listPayoutAccounts(client as unknown as XosClient);
  if (!result.ok) return null;
  return result.data
    .filter((p) => p.personId === personId)
    .map((p) => ({ id: p.id, orgId: p.orgId, provider: p.provider, last4: p.last4 }));
}

/**
 * The person's own tax forms (api_external.tax_forms), newest first, each W-9 with the name and address it holds;
 * null when a read failed.
 */
export async function readMyTaxForms(
  client: SupabaseClient,
  personId: string,
): Promise<TaxFormRow[] | null> {
  const db = client as unknown as XosClient;
  const [forms, addresses] = await Promise.all([listTaxForms(db), listW9Addresses(db)]);
  if (!forms.ok || !addresses.ok) return null;
  const address = new Map(addresses.data.map((a) => [a.taxFormId, a]));
  return forms.data
    .filter((f) => f.personId === personId)
    .map((f) => {
      const a = address.get(f.id);
      return {
        id: f.id,
        orgId: f.orgId,
        orgName: f.orgName,
        kind: f.kind,
        tinLast4: f.tinLast4,
        withholding: f.foreignPerformerWithholding,
        signedAt: f.signedAt,
        legalName: a?.legalName ?? null,
        streetAddress: a?.streetAddress ?? null,
        locality: a?.locality ?? null,
        regionCode: a?.regionCode ?? null,
        postalCode: a?.postalCode ?? null,
      };
    });
}

// What the screen shows -------------------------------------------------------------------------------------------

/** Where a tax form's mailing address stands: complete, still needed (a W-9 only), or not asked for (a W-8). */
export type AddressStanding = "complete" | "needed" | "none";

export function addressStanding(form: TaxFormRow): AddressStanding {
  if (form.kind !== "W-9") return "none";
  return form.streetAddress && form.locality && form.regionCode && form.postalCode
    ? "complete"
    : "needed";
}

/** Gateway's label key of a stored enum value: `Stripe Connect` reads gateway.enums.payoutProvider.stripeConnect. */
export function enumLabel(enumName: "payoutProvider" | "taxFormKind", value: string): string {
  return `gateway.enums.${enumName}.${enumKey(value)}`;
}

export interface PayoutItem {
  readonly id: string;
  /** The paying org's name, when the person's orgs or tax forms name it. */
  readonly orgName: string | null;
  readonly providerKey: string;
  readonly last4: string | null;
}

/**
 * The payout destinations by org name, then provider. The view carries no org name, so it comes from the person's
 * orgs on the device, else from a tax form given to the same org.
 */
export function payoutItems(
  payouts: readonly PayoutRow[],
  orgNames: ReadonlyMap<string, string>,
  forms: readonly TaxFormRow[],
): PayoutItem[] {
  const fromForms = new Map(forms.map((f) => [f.orgId, f.orgName]));
  return payouts
    .map((p) => ({
      id: p.id,
      orgName: orgNames.get(p.orgId) ?? fromForms.get(p.orgId) ?? null,
      providerKey: enumLabel("payoutProvider", p.provider),
      last4: p.last4,
    }))
    .sort(
      (a, b) =>
        (a.orgName ?? "￿").localeCompare(b.orgName ?? "￿") ||
        a.providerKey.localeCompare(b.providerKey),
    );
}

/** The tax forms newest first, as Gateway lists them. */
export function taxFormItems(forms: readonly TaxFormRow[]): TaxFormRow[] {
  return [...forms].sort((a, b) => b.signedAt.localeCompare(a.signedAt));
}

// The W-9 address -------------------------------------------------------------------------------------------------

/** The W-9 name and address as typed into the form. */
export interface TaxAddressInput {
  readonly legalName: string;
  readonly streetAddress: string;
  readonly locality: string;
  readonly regionCode: string;
  readonly postalCode: string;
}

/** The checked address, as app.set_tax_form_address takes it. */
export interface TaxAddress {
  readonly legalName: string | null;
  readonly streetAddress: string;
  readonly locality: string;
  readonly regionCode: string;
  readonly postalCode: string;
}

export type CheckedAddress =
  | { readonly ok: true; readonly value: TaxAddress }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

const W9 = "payouts.w9.errors";

/** The form's values as typed, starting from what the form holds. */
export function addressInput(form: TaxFormRow): TaxAddressInput {
  return {
    legalName: form.legalName ?? "",
    streetAddress: form.streetAddress ?? "",
    locality: form.locality ?? "",
    regionCode: form.regionCode ?? "",
    postalCode: form.postalCode ?? "",
  };
}

/**
 * Checks the address as Gateway's tax documents form does (setTaxFormAddressAction) and the tax_forms check
 * constraints do again: an optional name up to 200 characters, a street up to 200, a city up to 100, a two-letter
 * state and a five-digit ZIP or ZIP+4. Each failure names the message key shown under its field.
 */
export function checkTaxAddress(input: TaxAddressInput): CheckedAddress {
  const errors: Record<string, string> = {};
  const legalName = input.legalName.trim();
  const streetAddress = input.streetAddress.trim();
  const locality = input.locality.trim();
  const regionCode = input.regionCode.trim().toUpperCase();
  const postalCode = input.postalCode.trim();
  if (legalName.length > 200) errors["legalName"] = `${W9}.legalName`;
  if (streetAddress === "" || streetAddress.length > 200)
    errors["streetAddress"] = `${W9}.streetAddress`;
  if (locality === "" || locality.length > 100) errors["locality"] = `${W9}.locality`;
  if (!/^[A-Z]{2}$/.test(regionCode)) errors["regionCode"] = `${W9}.regionCode`;
  if (!/^[0-9]{5}(-[0-9]{4})?$/.test(postalCode)) errors["postalCode"] = `${W9}.postalCode`;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      legalName: legalName === "" ? null : legalName,
      streetAddress,
      locality,
      regionCode,
      postalCode,
    },
  };
}

/** True when the checked address is the one the form already holds, so there is nothing to save. */
export function sameAddress(form: TaxFormRow, address: TaxAddress): boolean {
  return (
    (form.legalName ?? null) === address.legalName &&
    form.streetAddress === address.streetAddress &&
    form.locality === address.locality &&
    form.regionCode === address.regionCode &&
    form.postalCode === address.postalCode
  );
}

/**
 * The address as a queued app.set_tax_form_address call, laying the new address on the device copy at once. The
 * call sets the same values however often it runs, so a replay after a lost answer changes nothing.
 */
export function taxAddressWrite(form: TaxFormRow, address: TaxAddress): MutationInput {
  return {
    op: "rpc",
    target: "set_tax_form_address",
    table: PAYOUT_TAX_MIRROR.taxForms,
    rowId: form.id,
    payload: {
      p_tax_form_id: form.id,
      p_legal_name: address.legalName ?? "",
      p_street_address: address.streetAddress,
      p_locality: address.locality,
      p_region_code: address.regionCode,
      p_postal_code: address.postalCode,
    },
    policy: "append",
    optimistic: { ...form, ...address },
  };
}

/** The message key for a refusal of the address the screen names, or undefined for the server's own sentence. */
export function taxAddressRuleKey(rule: string): string | undefined {
  return rule === "tax_form_address_incomplete"
    ? "compassSettings.payoutTax.addressIncomplete"
    : undefined;
}

// Steps in Gateway ------------------------------------------------------------------------------------------------

/**
 * Giving a tax form opens Gateway's engagements: the form goes to the org that asks for it, from the onboarding of
 * that engagement, and Compass has no engagement screen (app/e/[engagementKey].tsx opens Gateway too).
 */
export function giveTaxFormUrl(gatewayUrl: string): string {
  return `${gatewayUrl.replace(/\/+$/, "")}/work/engagements`;
}
