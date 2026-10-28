"use server";

import type { DataError } from "@xos/data";
import { reviewRosterEntry, rosterSharedWorkDetails } from "@xos/data/roster";
import type { SharedWorkDetails } from "@xos/data/work-details";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import type { AdvancingState } from "./actions";
import { KNOWN_ERRORS } from "./errors";

/**
 * Crew roster review in Atlas (R4, migration 2635): a reviewer with advancing.submission.review accepts
 * a submitted entry or returns it with a reason; the database refuses the entry's creator and its
 * submitter (sod_roster_reviewer). Bulk review goes through the bulk kit (app.bulk_update_roster_entries).
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
  | { readonly ok: true; readonly details: SharedWorkDetails }
  | { readonly ok: false; readonly error: string }
> {
  const ctx = await getOrgContext(org);
  if (!ctx) return { ok: false, error: "not-found" };
  const id = z.uuid().safeParse(rosterEntryId);
  if (!id.success) return { ok: false, error: "invalid" };
  const result = await rosterSharedWorkDetails(ctx.viewer.db, id.data);
  return result.ok
    ? { ok: true, details: result.data }
    : { ok: false, error: errorKey(result.error) };
}
