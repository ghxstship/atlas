"use server";

import { Constants } from "@xos/data/database.types";
import { createExternalAccount, submitTaxForm } from "@xos/data/gateway";
import {
  addIntakePayoutReference,
  intakeOrgId,
  myIntakePayout,
  myIntakeTaxForm,
  submitIntakeInvoice,
  submitVendorIntake,
  withdrawIntakeRequest,
  type IntakeInvoiceDraft,
} from "@xos/data/vendor-intake";
import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { z } from "zod";
import { outcomeFor, type ActionResult } from "@/lib/action-result";
import { INTAKE_GRANT_COOKIE, visitorAddress } from "@/lib/outside/public";
import { getGatewayContext } from "@/lib/shell/context";

/**
 * The signed-in half of a vendor intake (B2, ADR 0141). Each action runs as the person, with the link's token and the
 * grant from this path's cookie; the database decides. Everything Restricted goes through the existing paths: a tax
 * form through app.submit_tax_form, encrypted and shown as the last four. A bank number is refused.
 */

export type IntakeResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly outcome: string };

const token = z.string().regex(/^xvin_[0-9a-f]{64}$/);
const id = z.uuid();

async function linkContext(rawToken: string) {
  const ctx = await getGatewayContext();
  const parsed = token.safeParse(rawToken);
  if (!ctx || !parsed.success) return null;
  const grant = (await cookies()).get(INTAKE_GRANT_COOKIE)?.value ?? "";
  return {
    ctx,
    token: parsed.data,
    grant,
    clientAddress: visitorAddress(await headers()),
  };
}

export interface IntakeOnFileChoice {
  readonly taxForm: { readonly id: string; readonly kind: string; readonly last4: string } | null;
  readonly payout: { readonly id: string; readonly reference: string } | null;
}

/** What the person already filed with this org, offered instead of asking again (S4.4-37). */
export async function intakeOnFileAction(
  rawToken: string,
  accountId: string | null,
): Promise<IntakeResult<IntakeOnFileChoice>> {
  const link = await linkContext(rawToken);
  if (!link) return { ok: false, outcome: "notFound" };
  const org = await intakeOrgId(link.ctx.db, link);
  if (!org.ok) return { ok: false, outcome: outcomeFor(org.error) };
  const who = { orgId: org.data, accountId, personId: link.ctx.personId };
  const [tax, payout] = await Promise.all([
    myIntakeTaxForm(link.ctx.db, who),
    myIntakePayout(link.ctx.db, who),
  ]);
  if (!tax.ok) return { ok: false, outcome: outcomeFor(tax.error) };
  if (!payout.ok) return { ok: false, outcome: outcomeFor(payout.error) };
  return { ok: true, data: { taxForm: tax.data, payout: payout.data } };
}

export async function intakeCreateAccountAction(
  rawToken: string,
  input: { readonly name: string },
): Promise<IntakeResult<string>> {
  const link = await linkContext(rawToken);
  if (!link) return { ok: false, outcome: "notFound" };
  const name = input.name.trim();
  const slug = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 48);
  if (name.length === 0 || slug.length < 3) return { ok: false, outcome: "invalid" };
  const created = await createExternalAccount(link.ctx.db, { name, slug });
  if (!created.ok) return { ok: false, outcome: outcomeFor(created.error) };
  return { ok: true, data: created.data.accountId };
}

const taxInput = z.object({
  formKind: z.enum(Constants.app.Enums.tax_form_kind),
  tin: z.string().trim().min(4).max(40),
  withholding: z.boolean(),
  accountId: id.nullable(),
});

export async function intakeTaxFormAction(
  rawToken: string,
  input: z.input<typeof taxInput>,
): Promise<IntakeResult<{ readonly taxFormId: string; readonly last4: string }>> {
  const link = await linkContext(rawToken);
  const parsed = taxInput.safeParse(input);
  if (!link) return { ok: false, outcome: "notFound" };
  if (!parsed.success) return { ok: false, outcome: "refusals.tin_format" };
  const org = await intakeOrgId(link.ctx.db, link);
  if (!org.ok) return { ok: false, outcome: outcomeFor(org.error) };
  const filed = await submitTaxForm(link.ctx.db, {
    orgId: org.data,
    formKind: parsed.data.formKind,
    tin: parsed.data.tin,
    accountId: parsed.data.accountId,
    foreignPerformerWithholding: parsed.data.withholding,
  });
  if (!filed.ok) return { ok: false, outcome: outcomeFor(filed.error) };
  return {
    ok: true,
    data: {
      taxFormId: filed.data.taxFormId,
      last4: parsed.data.tin.replace(/[^0-9A-Za-z]/g, "").slice(-4),
    },
  };
}

export async function intakePayoutAction(
  rawToken: string,
  input: { readonly reference: string; readonly accountId: string | null },
): Promise<IntakeResult<string>> {
  const link = await linkContext(rawToken);
  if (!link) return { ok: false, outcome: "notFound" };
  const added = await addIntakePayoutReference(link.ctx.db, {
    token: link.token,
    grant: link.grant,
    reference: input.reference,
    accountId: input.accountId,
    clientAddress: link.clientAddress,
  });
  return added.ok
    ? { ok: true, data: added.data }
    : { ok: false, outcome: outcomeFor(added.error) };
}

export async function intakeSubmitAction(
  rawToken: string,
  input: {
    readonly accountId: string | null;
    readonly taxFormId: string | null;
    readonly payoutAccountId: string | null;
    readonly signerName: string | null;
    readonly invoiceDraft: IntakeInvoiceDraft | null;
  },
): Promise<IntakeResult<string>> {
  const link = await linkContext(rawToken);
  if (!link) return { ok: false, outcome: "notFound" };
  const sent = await submitVendorIntake(link.ctx.db, {
    token: link.token,
    grant: link.grant,
    clientAddress: link.clientAddress,
    ...input,
  });
  if (!sent.ok) return { ok: false, outcome: outcomeFor(sent.error) };
  revalidatePath("/home");
  return { ok: true, data: sent.data };
}

/** Withdraws the person's own request from Home. */
export async function withdrawIntakeAction(requestId: string): Promise<ActionResult> {
  const ctx = await getGatewayContext();
  const parsed = id.safeParse(requestId);
  if (!ctx || !parsed.success) return { ok: false, outcome: "notFound" };
  const done = await withdrawIntakeRequest(ctx.db, parsed.data);
  if (!done.ok) return { ok: false, outcome: outcomeFor(done.error) };
  revalidatePath("/home");
  return { ok: true };
}

/** Submits the stored first invoice once the money area is open (Section 8.7). */
export async function submitIntakeInvoiceAction(requestId: string): Promise<ActionResult> {
  const ctx = await getGatewayContext();
  const parsed = id.safeParse(requestId);
  if (!ctx || !parsed.success) return { ok: false, outcome: "notFound" };
  const done = await submitIntakeInvoice(ctx.db, parsed.data);
  if (!done.ok) return { ok: false, outcome: outcomeFor(done.error) };
  revalidatePath("/home");
  return { ok: true };
}
