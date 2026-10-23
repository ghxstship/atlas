"use server";

import { listPendingReacceptances } from "@xos/data/legal-reacceptance";
import { recordLegalAcceptances } from "@xos/data/settings";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { clientIp } from "@/lib/auth/legal";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Accepts an announced legal change for the org (Section 14.4, migration 1383), from Settings, Legal.
 * Only a version the database is asking this person about can be accepted, so the form cannot record
 * an arbitrary version; app.record_legal_acceptances checks org.legal.accept and records the time,
 * the address and the person.
 */
export async function acceptLegalChangeAction(form: FormData): Promise<void> {
  const ctx = await getOrgContext(String(form.get("org") ?? ""));
  if (!ctx) return;
  const slug = String(form.get("document") ?? "");
  const version = String(form.get("version") ?? "");
  const pending = await listPendingReacceptances(ctx.viewer.db, ctx.org.id);
  const asked =
    pending.ok &&
    pending.data.some((p) => p.documentSlug === slug && p.documentVersion === version);
  if (!asked) return;
  const recorded = await recordLegalAcceptances(ctx.viewer.db, {
    orgId: ctx.org.id,
    documents: [{ slug, version }],
    clientIp: clientIp(await headers()),
  });
  if (!recorded.ok) console.error("legal acceptance was not recorded", recorded.error);
  revalidatePath(`/${ctx.org.slug}`, "layout");
}
