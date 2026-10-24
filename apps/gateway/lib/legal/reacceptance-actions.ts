"use server";

import { listPendingReacceptances } from "@xos/data/legal-reacceptance";
import { recordLegalAcceptances } from "@xos/data/settings";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { clientIp } from "@/lib/auth/legal";
import { createServerSupabase } from "@/lib/supabase/server";
import { observability } from "@/lib/observability";

/**
 * Accepts an announced change to a personal legal document such as the Worker Terms (Section 14.4,
 * migration 1383) from the prompt in the Gateway shell. Only a version the database is asking this
 * person about can be accepted; the acceptance is personal (no org) and records the time, the address
 * and the person (app.record_legal_acceptances).
 */
export async function acceptPersonalLegalChangeAction(form: FormData): Promise<void> {
  const db = await createServerSupabase();
  const slug = String(form.get("document") ?? "");
  const version = String(form.get("version") ?? "");
  const pending = await listPendingReacceptances(db, null);
  const asked =
    pending.ok &&
    pending.data.some((p) => p.documentSlug === slug && p.documentVersion === version);
  if (!asked) return;
  const recorded = await recordLegalAcceptances(db, {
    orgId: null,
    documents: [{ slug, version }],
    clientIp: clientIp(await headers()),
  });
  if (!recorded.ok)
    observability.logger.error("legal acceptance was not recorded", { error: recorded.error });
  revalidatePath("/", "layout");
}
