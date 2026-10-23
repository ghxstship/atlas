"use server";

import { addCalendarDays, startOfDayIn } from "@xos/data/calendar";
import {
  acceptOwnershipTransfer,
  cancelOwnershipTransfer,
  declineOwnershipTransfer,
  endStandingGrant,
  leavePartner,
  offerOwnershipTransfer,
  recordStandingGrant,
  recoverOrgDeletion,
  requestDomainCheck,
  requestOrgDeletion,
} from "@xos/data/org-lifecycle";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStepUp } from "@/lib/auth/step-up";
import { contextFor } from "@/lib/platform/action-context";
import { getOrgTimeZone } from "@/lib/shell/time-zone";
import {
  done,
  field,
  fromDataError,
  inputError,
  type PlatformActionState,
} from "@/lib/platform/state";

/**
 * A79's actions (Section 4.6.1, Section 12, Section 14.7): delete and recover the org, offer, withdraw, accept
 * and decline ownership, leave the partner, record and end standing partner grants, and check a custom domain
 * again. The RPCs decide every rule; deleting, offering, accepting and leaving the partner (A99) also pass A77's
 * step-up check first
 * (lib/auth/step-up.ts), so a session without a recent second factor hears so before anything runs and the
 * form opens the step-up dialog.
 */

const uuid = z.uuid();
const stepUpRefused = (): PlatformActionState => ({ rule: "step_up_required", at: Date.now() });

export async function requestOrgDeletionAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ confirm: z.string().min(1).max(200), reason: z.string().min(1).max(1000) })
    .safeParse({ confirm: field(form, "confirm"), reason: field(form, "reason") });
  if (!parsed.success) return inputError();
  if (!(await requireStepUp(ctx.viewer.db, "delete the organization")).ok) return stepUpRefused();
  const result = await requestOrgDeletion(ctx.viewer.db, {
    orgId: ctx.org.id,
    confirmName: parsed.data.confirm,
    reason: parsed.data.reason,
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return done(result.data);
}

export async function recoverOrgDeletionAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const result = await recoverOrgDeletion(ctx.viewer.db, ctx.org.id);
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return done(result.data);
}

export async function offerOwnershipAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ person: uuid, outcome: z.enum(["admin", "leave"]) })
    .safeParse({ person: field(form, "person"), outcome: field(form, "outcome") });
  if (!parsed.success) return inputError();
  if (!(await requireStepUp(ctx.viewer.db, "transfer ownership")).ok) return stepUpRefused();
  const result = await offerOwnershipTransfer(ctx.viewer.db, {
    orgId: ctx.org.id,
    toPersonId: parsed.data.person,
    outcome: parsed.data.outcome,
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/settings/danger-zone`);
  return done(result.data);
}

export async function cancelOwnershipAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const transfer = field(form, "transfer");
  if (!uuid.safeParse(transfer).success) return inputError();
  const result = await cancelOwnershipTransfer(ctx.viewer.db, transfer);
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/settings/danger-zone`);
  return done(result.data);
}

export async function acceptOwnershipAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const transfer = field(form, "transfer");
  if (!uuid.safeParse(transfer).success) return inputError();
  if (!(await requireStepUp(ctx.viewer.db, "accept ownership")).ok) return stepUpRefused();
  const result = await acceptOwnershipTransfer(ctx.viewer.db, transfer);
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return done(result.data);
}

export async function declineOwnershipAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const transfer = field(form, "transfer");
  if (!uuid.safeParse(transfer).success) return inputError();
  const result = await declineOwnershipTransfer(ctx.viewer.db, transfer);
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return done(result.data);
}

export async function leavePartnerAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const confirm = field(form, "confirm");
  if (confirm.length === 0 || confirm.length > 200) return inputError();
  // Leaving ends the partner-billed subscription: a billing change, so step-up first (A99, migration 1562).
  if (!(await requireStepUp(ctx.viewer.db, "leave your partner")).ok) return stepUpRefused();
  const result = await leavePartner(ctx.viewer.db, { orgId: ctx.org.id, confirmName: confirm });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return done(result.data);
}

export async function recordStandingGrantAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      capability: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
      until: z.iso.date(),
      reference: z.string().min(1).max(300),
    })
    .safeParse({
      capability: field(form, "capability"),
      until: field(form, "until"),
      reference: field(form, "reference"),
    });
  if (!parsed.success) return inputError();
  // The grant runs through the chosen day on the org's calendar: it ends at the org's next midnight.
  const zone = await getOrgTimeZone(ctx);
  const result = await recordStandingGrant(ctx.viewer.db, {
    orgId: ctx.org.id,
    capabilityCode: parsed.data.capability,
    validTo: startOfDayIn(addCalendarDays(parsed.data.until, 1), zone),
    agreementReference: parsed.data.reference,
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/settings/security`);
  return done(result.data);
}

export async function endStandingGrantAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const grant = field(form, "grant");
  if (!uuid.safeParse(grant).success) return inputError();
  const result = await endStandingGrant(ctx.viewer.db, grant);
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/settings/security`);
  return done(result.data);
}

export async function requestDomainCheckAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const domain = field(form, "domain");
  if (!uuid.safeParse(domain).success) return inputError();
  const result = await requestDomainCheck(ctx.viewer.db, domain);
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/settings/white-label`);
  return done(result.data);
}
