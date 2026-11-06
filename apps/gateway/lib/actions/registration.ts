"use server";

import { submitRegistration, withdrawRegistration } from "@xos/data/gateway";
import { setPersonalSetting } from "@xos/data/settings";
import { regionFromLocale, toE164 } from "@xos/i18n/phone";
import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { outcomeFor, toAction, type ActionResult } from "@/lib/action-result";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Registering on a crew registration page (B10, G-129, ADR 0149 decision 3). The person registers from their own account;
 * the work phone saves to their own settings and any profile share is theirs. The database decides every refusal.
 */

export interface RegistrationState {
  readonly outcome?: string;
  readonly refusal?: string;
  readonly at?: number;
}

const SECTIONS = [
  "headline",
  "bio",
  "pronouns",
  "location",
  "skills",
  "certifications",
  "rates",
  "languages",
  "links",
] as const;

export async function submitRegistrationAction(
  _: RegistrationState,
  form: FormData,
): Promise<RegistrationState> {
  const parsed = z
    .object({
      orgSlug: z.string().min(1).max(100),
      pageSlug: z.string().min(1).max(80),
      orgId: z.uuid(),
      phone: z.string().trim().max(40),
      ageConfirmed: z.string().default(""),
      sections: z.string().default(""),
    })
    .safeParse({
      orgSlug: form.get("orgSlug"),
      pageSlug: form.get("pageSlug"),
      orgId: form.get("orgId"),
      phone: form.get("phone") ?? "",
      ageConfirmed: form.get("ageConfirmed") ?? "",
      sections: form.get("sections") ?? "",
    });
  if (!parsed.success) return { outcome: "invalid", at: Date.now() };
  const v = parsed.data;
  const db = await createServerSupabase();
  if (v.phone) {
    const phone = toE164(v.phone, regionFromLocale(await getLocale()));
    if (!phone) return { refusal: "registration_phone", at: Date.now() };
    const saved = await setPersonalSetting(db, { key: "workforce.work_phone", value: phone });
    if (!saved.ok) return { outcome: outcomeFor(saved.error), at: Date.now() };
  }
  const sections = v.sections.split(",").filter((s) => (SECTIONS as readonly string[]).includes(s));
  let shareId: string | null = null;
  if (sections.length > 0) {
    const shared = await db.rpc("share_profile_sections", {
      p_org_id: v.orgId,
      p_profile_share_id: null as unknown as string,
      p_sections: sections as never,
    });
    if (shared.error) return { outcome: "unexpected", at: Date.now() };
    shareId = shared.data as string;
  }
  const answers = [...form.entries()].flatMap(([key, value]) =>
    key.startsWith("answer:") && typeof value === "string" && value.trim() !== ""
      ? [{ questionId: key.slice("answer:".length), answer: value.trim() }]
      : [],
  );
  const result = await submitRegistration(db, {
    orgSlug: v.orgSlug,
    pageSlug: v.pageSlug,
    answers,
    ageConfirmed: v.ageConfirmed === "true",
    profileShareId: shareId,
  });
  if (!result.ok) {
    return result.error.kind === "refusal"
      ? { refusal: result.error.rule, at: Date.now() }
      : { outcome: outcomeFor(result.error), at: Date.now() };
  }
  revalidatePath(`/join/${v.orgSlug}/${v.pageSlug}`);
  return { at: Date.now() };
}

export async function withdrawRegistrationAction(id: string, path: string): Promise<ActionResult> {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return { ok: false, outcome: "invalid" };
  const result = await withdrawRegistration(await createServerSupabase(), parsed.data);
  if (result.ok) revalidatePath(path);
  return toAction(result);
}
