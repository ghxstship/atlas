"use server";

import {
  addSupplierDiversity,
  removeSupplierDiversity,
  revokeSupplierDiversityShare,
  shareSupplierDiversity,
  SUPPLIER_DIVERSITY_KINDS,
} from "@xos/data/supplier-diversity";
import { z } from "zod";
import type { SimpleFormState } from "@/components/forms/simple-form";
import { outcomeFor, toAction, type ActionResult } from "@/lib/action-result";
import { getGatewayContext } from "@/lib/shell/context";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Supplier diversity server actions (Section 4.4.1, migration 1464): the owner declares, removes and
 * shares their own certifications, as themselves or for the company they act as (Owner or Admin).
 * The database decides every refusal: an org without a program takes none.
 */

const optionalDate = z.union([z.literal(""), z.iso.date()]).transform((v) => v || null);

export async function addSupplierDiversityAction(
  _: SimpleFormState,
  form: FormData,
): Promise<SimpleFormState> {
  const ctx = await getGatewayContext();
  if (!ctx) return { outcome: "notFound" };
  const parsed = z
    .object({
      kind: z.enum(SUPPLIER_DIVERSITY_KINDS),
      certifyingBody: z.string().trim().min(1).max(200),
      // The database keeps the letters and digits (1661), so a number needs at least one.
      certificateNumber: z
        .string()
        .trim()
        .max(100)
        .refine((v) => v === "" || /[0-9A-Za-z]/.test(v)),
      issuedOn: optionalDate,
      expiresOn: optionalDate,
    })
    .safeParse({
      kind: form.get("kind"),
      certifyingBody: form.get("certifyingBody") ?? "",
      certificateNumber: form.get("certificateNumber") ?? "",
      issuedOn: form.get("issuedOn") ?? "",
      expiresOn: form.get("expiresOn") ?? "",
    });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return { fieldError: typeof field === "string" ? field : "kind" };
  }
  if (
    parsed.data.issuedOn &&
    parsed.data.expiresOn &&
    parsed.data.expiresOn < parsed.data.issuedOn
  ) {
    return { fieldError: "expiresOn" };
  }
  const result = await addSupplierDiversity(ctx.db, {
    personId: ctx.personId,
    accountId: ctx.acting?.id ?? null,
    kind: parsed.data.kind,
    certifyingBody: parsed.data.certifyingBody,
    certificateNumber: parsed.data.certificateNumber || null,
    issuedOn: parsed.data.issuedOn,
    expiresOn: parsed.data.expiresOn,
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function removeSupplierDiversityAction(id: string): Promise<ActionResult> {
  return toAction(await removeSupplierDiversity(await createServerSupabase(), z.uuid().parse(id)));
}

export async function shareSupplierDiversityAction(
  _: SimpleFormState,
  form: FormData,
): Promise<SimpleFormState> {
  const parsed = z
    .object({ certificationId: z.uuid(), orgId: z.uuid() })
    .safeParse({ certificationId: form.get("certificationId"), orgId: form.get("orgId") });
  if (!parsed.success) return { fieldError: "orgId" };
  const result = await shareSupplierDiversity(await createServerSupabase(), parsed.data);
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function revokeSupplierDiversityShareAction(shareId: string): Promise<ActionResult> {
  return toAction(
    await revokeSupplierDiversityShare(await createServerSupabase(), z.uuid().parse(shareId)),
  );
}
