"use server";

import { submitRegistration, withdrawRegistration } from "@xos/data/gateway";
import { regionFromLocale, toE164 } from "@xos/i18n/phone";
import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { outcomeFor, toAction, type ActionResult } from "@/lib/action-result";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Registering on a crew registration page (B10, G-129, ADR 0149 decision 3). The person registers from their own account;
 * the work phone goes to their own settings and any profile share is theirs. The database decides every refusal and writes
 * all of it in one transaction, so a refused registration neither shares a profile nor saves a phone.
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

function isSection(value: string): value is (typeof SECTIONS)[number] {
  return (SECTIONS as readonly string[]).includes(value);
}

export async function submitRegistrationAction(
  _: RegistrationState,
  form: FormData,
): Promise<RegistrationState> {
  const parsed = z
    .object({
      orgSlug: z.string().min(1).max(100),
      pageSlug: z.string().min(1).max(80),
      phone: z.string().trim().max(40),
      ageConfirmed: z.string().default(""),
      sections: z.string().default(""),
    })
    .safeParse({
      orgSlug: form.get("orgSlug"),
      pageSlug: form.get("pageSlug"),
      phone: form.get("phone") ?? "",
      ageConfirmed: form.get("ageConfirmed") ?? "",
      sections: form.get("sections") ?? "",
    });
  if (!parsed.success) return { outcome: "invalid", at: Date.now() };
  const v = parsed.data;
  let workPhone: string | null = null;
  if (v.phone) {
    workPhone = toE164(v.phone, regionFromLocale(await getLocale()));
    if (!workPhone) return { refusal: "registration_phone", at: Date.now() };
  }
  const answers = [...form.entries()].flatMap(([key, value]) =>
    key.startsWith("answer:") && typeof value === "string" && value.trim() !== ""
      ? [{ questionId: key.slice("answer:".length), answer: value.trim() }]
      : [],
  );
  const db = await createServerSupabase();
  const result = await submitRegistration(db, {
    orgSlug: v.orgSlug,
    pageSlug: v.pageSlug,
    answers,
    ageConfirmed: v.ageConfirmed === "true",
    shareSections: v.sections.split(",").filter(isSection),
    workPhone,
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
