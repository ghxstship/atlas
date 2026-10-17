"use server";

import { setTaxFormAddress } from "@xos/data/form-1099";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { outcomeFor } from "@/lib/action-result";
import { getGatewayContext } from "@/lib/shell/context";
import type { FormResult } from "./operations";

/**
 * The payee completes the name and mailing address on its W-9 (A43, finding A38-006): the 1099-NEC
 * each org files at year end needs them. The database checks that the form is the caller's own.
 */
export async function setTaxFormAddressAction(_: FormResult, form: FormData): Promise<FormResult> {
  const ctx = await getGatewayContext();
  if (!ctx) return { outcome: "notFound" };
  const parsed = z
    .object({
      taxFormId: z.uuid(),
      legalName: z.string().trim().max(200),
      streetAddress: z.string().trim().min(1).max(200),
      locality: z.string().trim().min(1).max(100),
      regionCode: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{2}$/),
      postalCode: z
        .string()
        .trim()
        .regex(/^[0-9]{5}(-[0-9]{4})?$/),
    })
    .safeParse(Object.fromEntries(form.entries()));
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "streetAddress");
    return { fieldError: field };
  }
  const result = await setTaxFormAddress(ctx.db, {
    ...parsed.data,
    legalName: parsed.data.legalName === "" ? null : parsed.data.legalName,
  });
  if (!result.ok) return { outcome: outcomeFor(result.error) };
  revalidatePath("/money/tax-documents");
  return { done: true };
}
