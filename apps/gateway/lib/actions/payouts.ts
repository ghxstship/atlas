"use server";

import { setTaxFormAddress } from "@xos/data/form-1099";
import { addressProblems, normalizePostalCode, type AddressField } from "@xos/i18n/formats";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { outcomeFor } from "@/lib/action-result";
import { getGatewayContext } from "@/lib/shell/context";
import type { FormResult } from "./operations";

/**
 * The payee completes the name and mailing address on its W-9 (A43, finding A38-006): the 1099-NEC
 * each org files at year end needs them. The database checks that the form is the caller's own.
 */
/** The form field of each address field the US format checks. */
const FIELD: Partial<Record<AddressField, string>> = {
  addressLines: "streetAddress",
  locality: "locality",
  administrativeArea: "regionCode",
  postalCode: "postalCode",
};

export async function setTaxFormAddressAction(_: FormResult, form: FormData): Promise<FormResult> {
  const ctx = await getGatewayContext();
  if (!ctx) return { outcome: "notFound" };
  const parsed = z
    .object({
      taxFormId: z.uuid(),
      legalName: z.string().trim().max(200),
      streetAddress: z.string().trim().max(200),
      locality: z.string().trim().max(100),
      regionCode: z.string().trim().toUpperCase(),
      postalCode: z.string().trim(),
    })
    .safeParse(Object.fromEntries(form.entries()));
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "streetAddress");
    return { fieldError: field };
  }
  // A W-9 address is a US address: the fields and ZIP code the US format requires (Section 15), as
  // Atlas checks addresses, with the ZIP written as the post writes it (94104-1234).
  const address = { ...parsed.data, postalCode: normalizePostalCode("US", parsed.data.postalCode) };
  const problem = addressProblems({
    country: "US",
    addressLines: [address.streetAddress],
    locality: address.locality,
    administrativeArea: address.regionCode,
    postalCode: address.postalCode,
  })[0];
  if (problem) return { fieldError: FIELD[problem] ?? "streetAddress" };
  if (!/^[A-Z]{2}$/.test(address.regionCode)) return { fieldError: "regionCode" };
  const result = await setTaxFormAddress(ctx.db, {
    ...address,
    legalName: address.legalName === "" ? null : address.legalName,
  });
  if (!result.ok) return { outcome: outcomeFor(result.error) };
  revalidatePath("/money/tax-documents");
  return { done: true };
}
