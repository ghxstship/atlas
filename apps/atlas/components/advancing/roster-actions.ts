"use server";

import type { DataError } from "@xos/data";
import { instantOfLocalIn } from "@xos/data/calendar";
import { reviewRosterEntry, rosterSharedWorkDetails, setRosterLock } from "@xos/data/roster";
import { getRosterProjectFacts, type RosterProjectFacts } from "@xos/data/roster-facts";
import type { SharedWorkDetails } from "@xos/data/work-details";
import { formatPhone, regionFromLocale } from "@xos/i18n/formats";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { sharedPhones } from "@/components/work-details/shared-categories";
import { getOrgContext } from "@/lib/shell/context";
import type { AdvancingState } from "./actions";
import { KNOWN_ERRORS } from "./errors";

/**
 * Crew roster review in Atlas (R4, migration 2635): a reviewer with advancing.submission.review accepts
 * a submitted entry or returns it with a reason; the database refuses the entry's creator and its
 * submitter (sod_roster_reviewer). Bulk review goes through the bulk kit (app.bulk_update_roster_entries).
 *
 * R5 adds the names lock a writer sets per engagement (app.set_roster_lock, 2656) and the logged read of an entry's
 * project facts when its peek opens (app.roster_project_facts, 2655).
 */

function errorKey(error: DataError): string {
  if (error.kind === "refusal") return KNOWN_ERRORS.has(error.rule) ? error.rule : "refused";
  return error.kind;
}

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

export async function reviewRosterEntryAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      id: z.uuid(),
      outcome: z.enum(["Accepted", "Returned"]),
      reason: z.string().trim().max(500),
    })
    .safeParse({
      id: form.get("id"),
      outcome: form.get("outcome"),
      reason: form.get("reason") ?? "",
    });
  if (!parsed.success) return { error: "invalid" };
  if (parsed.data.outcome === "Returned" && parsed.data.reason === "") {
    return { fieldErrors: { reason: "required" } };
  }
  const result = await reviewRosterEntry(
    ctx.viewer.db,
    parsed.data.id,
    parsed.data.outcome,
    parsed.data.reason === "" ? null : parsed.data.reason,
  );
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

/** One logged read of a rostered person's shared work details, when the profile peek opens. */
export async function rosterProfileAction(
  org: string,
  rosterEntryId: string,
): Promise<
  | {
      readonly ok: true;
      readonly details: SharedWorkDetails;
      /** Phone numbers formatted for the viewer here: the phone metadata stays out of the client. */
      readonly phones: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly error: string }
> {
  const ctx = await getOrgContext(org);
  if (!ctx) return { ok: false, error: "not-found" };
  const id = z.uuid().safeParse(rosterEntryId);
  if (!id.success) return { ok: false, error: "invalid" };
  const result = await rosterSharedWorkDetails(ctx.viewer.db, id.data);
  if (!result.ok) return { ok: false, error: errorKey(result.error) };
  const region = regionFromLocale(await getLocale());
  const phones = Object.fromEntries(
    sharedPhones(result.data).map((p) => [p, formatPhone(p, region)] as const),
  );
  return { ok: true, details: result.data, phones };
}

/** Sets or clears an engagement's names lock; the time is typed in the project's zone. */
export async function setRosterLockAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      engagementId: z.uuid(),
      intent: z.enum(["set", "clear"]),
      locksAt: z.string().trim().max(40),
      timeZone: z.string().trim().min(1).max(64),
    })
    .safeParse({
      engagementId: form.get("engagementId"),
      intent: form.get("intent"),
      locksAt: form.get("locksAt") ?? "",
      timeZone: form.get("timeZone"),
    });
  if (!parsed.success) return { error: "invalid" };
  let locksAt: string | null = null;
  if (parsed.data.intent === "set") {
    locksAt = instantOfLocalIn(parsed.data.locksAt, parsed.data.timeZone);
    if (!locksAt) return { fieldErrors: { locksAt: "required" } };
  }
  const result = await setRosterLock(ctx.viewer.db, parsed.data.engagementId, locksAt);
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

/**
 * One logged read of a roster entry's project facts, when its peek opens: the kinds the reader's capabilities on the
 * project open, with who entered each (app.roster_project_facts writes project_facts.viewed and an audit event).
 */
export async function rosterProjectFactsAction(
  org: string,
  rosterEntryId: string,
): Promise<
  | { readonly ok: true; readonly facts: RosterProjectFacts }
  | { readonly ok: false; readonly error: string }
> {
  const ctx = await getOrgContext(org);
  if (!ctx) return { ok: false, error: "not-found" };
  const id = z.uuid().safeParse(rosterEntryId);
  if (!id.success) return { ok: false, error: "invalid" };
  const result = await getRosterProjectFacts(ctx.viewer.db, id.data);
  if (!result.ok) return { ok: false, error: errorKey(result.error) };
  return { ok: true, facts: result.data };
}
