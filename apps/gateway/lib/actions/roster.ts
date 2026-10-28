"use server";

import { endAccountMembership } from "@xos/data/gateway";
import {
  acceptAccountMembership,
  addRosterEntry,
  assignEngagementMember,
  inviteAccountMember,
  inviteToRoster,
  reissueRosterInvitation,
  respondPartyInvitation,
  respondRosterEntry,
  revokeAccountInvitation,
  rosterSharedWorkDetails,
  submitRoster,
  unassignEngagementMember,
  updateRosterEntry,
  withdrawRosterEntry,
} from "@xos/data/roster";
import type { SharedWorkDetails } from "@xos/data/work-details";
import { z } from "zod";
import { outcomeFor, toAction, type ActionResult } from "@/lib/action-result";
import type { FormResult } from "@/lib/actions/operations";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * The crew roster in Gateway (R4, migrations 2630 to 2642): roster managers add people from the
 * team or invite them by email, submit the roster and withdraw entries; each person answers their
 * own entry; account Owners and Admins assign members to engagements and invite addresses to the
 * account. The database decides who may do each and refuses with a named rule.
 */

const entryFields = z
  .object({
    roleCode: z.string().trim().max(20),
    arrivalStartsAt: z.string().trim().max(40),
    arrivalEndsAt: z.string().trim().max(40),
    arrivalTimeZone: z.string().trim().max(64),
  })
  .transform((f) => ({
    roleCode: f.roleCode === "" ? null : f.roleCode,
    arrivalStartsAt: f.arrivalStartsAt === "" ? null : localToInstant(f.arrivalStartsAt, f.arrivalTimeZone),
    arrivalEndsAt: f.arrivalEndsAt === "" ? null : localToInstant(f.arrivalEndsAt, f.arrivalTimeZone),
    arrivalTimeZone: f.arrivalStartsAt === "" && f.arrivalEndsAt === "" ? null : f.arrivalTimeZone || null,
  }));

function fieldsOf(form: FormData) {
  return {
    roleCode: form.get("roleCode") ?? "",
    arrivalStartsAt: form.get("arrivalStartsAt") ?? "",
    arrivalEndsAt: form.get("arrivalEndsAt") ?? "",
    arrivalTimeZone: form.get("arrivalTimeZone") ?? "",
  };
}

/**
 * A `datetime-local` value read in an IANA zone, as an ISO instant. The arrival window is typed in the
 * project's zone (Section 7.1), never the browser's.
 */
function localToInstant(local: string, timeZone: string): string {
  const asUtc = new Date(`${local}:00Z`);
  if (Number.isNaN(asUtc.getTime())) return local;
  if (!timeZone) return asUtc.toISOString();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(asUtc);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(asUtc.getTime() - (shown - asUtc.getTime())).toISOString();
}

export async function addRosterEntryAction(_: FormResult, form: FormData): Promise<FormResult> {
  const id = z.object({ engagementId: z.uuid(), personId: z.uuid() }).safeParse({
    engagementId: form.get("engagementId"),
    personId: form.get("personId"),
  });
  if (!id.success) return { fieldError: "rosterPerson" };
  const fields = entryFields.safeParse(fieldsOf(form));
  if (!fields.success) return { fieldError: "rosterArrival" };
  const result = await addRosterEntry(await createServerSupabase(), { ...id.data, ...fields.data });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function inviteToRosterAction(_: FormResult, form: FormData): Promise<FormResult> {
  const id = z.object({ engagementId: z.uuid(), email: z.email().max(320) }).safeParse({
    engagementId: form.get("engagementId"),
    email: String(form.get("email") ?? "").trim(),
  });
  if (!id.success) return { fieldError: "rosterEmail" };
  const fields = entryFields.safeParse(fieldsOf(form));
  if (!fields.success) return { fieldError: "rosterArrival" };
  const result = await inviteToRoster(await createServerSupabase(), { ...id.data, ...fields.data });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function updateRosterEntryAction(_: FormResult, form: FormData): Promise<FormResult> {
  const id = z.uuid().safeParse(form.get("rosterEntryId"));
  if (!id.success) return { fieldError: "rosterPerson" };
  const fields = entryFields.safeParse(fieldsOf(form));
  if (!fields.success) return { fieldError: "rosterArrival" };
  const result = await updateRosterEntry(await createServerSupabase(), id.data, fields.data);
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function submitRosterAction(engagementId: string): Promise<ActionResult> {
  return toAction(await submitRoster(await createServerSupabase(), engagementId));
}

export async function withdrawRosterEntryAction(rosterEntryId: string, reason: string): Promise<ActionResult> {
  return toAction(await withdrawRosterEntry(await createServerSupabase(), rosterEntryId, reason));
}

export async function reissueRosterInvitationAction(rosterEntryId: string): Promise<ActionResult> {
  return toAction(await reissueRosterInvitation(await createServerSupabase(), rosterEntryId));
}

export async function respondRosterEntryAction(
  rosterEntryId: string,
  response: "Accepted" | "Declined",
): Promise<ActionResult> {
  return toAction(await respondRosterEntry(await createServerSupabase(), rosterEntryId, response));
}

/** The profile a roster manager opens: one logged read per open, never on list load. */
export async function viewRosterProfileAction(
  rosterEntryId: string,
): Promise<{ readonly ok: true; readonly details: SharedWorkDetails } | { readonly ok: false; readonly outcome: string }> {
  const result = await rosterSharedWorkDetails(await createServerSupabase(), rosterEntryId);
  return result.ok ? { ok: true, details: result.data } : { ok: false, outcome: outcomeFor(result.error) };
}

// Invitations and membership ----------------------------------------------------------------------------

export async function respondPartyInvitationAction(
  kind: "account" | "roster",
  invitationId: string,
  accept: boolean,
): Promise<ActionResult> {
  return toAction(await respondPartyInvitation(await createServerSupabase(), kind, invitationId, accept));
}

export async function acceptAccountMembershipAction(accountMembershipId: string): Promise<ActionResult> {
  return toAction(await acceptAccountMembership(await createServerSupabase(), accountMembershipId));
}

export async function leaveAccountMembershipAction(accountMembershipId: string): Promise<ActionResult> {
  return toAction(await endAccountMembership(await createServerSupabase(), accountMembershipId));
}

export async function inviteAccountMemberAction(_: FormResult, form: FormData): Promise<FormResult> {
  const parsed = z
    .object({
      accountId: z.uuid(),
      email: z.email().max(320),
      role: z.enum(["Account Owner", "Account Admin", "Account Finance", "Account Member"]),
    })
    .safeParse({
      accountId: form.get("accountId"),
      email: String(form.get("email") ?? "").trim(),
      role: form.get("role"),
    });
  if (!parsed.success) return { fieldError: "inviteEmail" };
  const result = await inviteAccountMember(
    await createServerSupabase(),
    parsed.data.accountId,
    parsed.data.email,
    parsed.data.role,
  );
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function revokeAccountInvitationAction(invitationId: string): Promise<ActionResult> {
  return toAction(await revokeAccountInvitation(await createServerSupabase(), invitationId));
}

// Account team on an engagement ----------------------------------------------------------------------------

export async function assignEngagementMemberAction(_: FormResult, form: FormData): Promise<FormResult> {
  const parsed = z
    .object({
      engagementId: z.uuid(),
      accountMembershipId: z.uuid(),
      duty: z.enum(["Advancing Lead", "Member"]),
    })
    .safeParse({
      engagementId: form.get("engagementId"),
      accountMembershipId: form.get("accountMembershipId"),
      duty: form.get("duty"),
    });
  if (!parsed.success) return { fieldError: "assignMember" };
  const result = await assignEngagementMember(
    await createServerSupabase(),
    parsed.data.engagementId,
    parsed.data.accountMembershipId,
    parsed.data.duty,
  );
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function unassignEngagementMemberAction(assignmentId: string): Promise<ActionResult> {
  return toAction(await unassignEngagementMember(await createServerSupabase(), assignmentId));
}
