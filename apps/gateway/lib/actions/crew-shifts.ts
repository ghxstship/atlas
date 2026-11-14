"use server";

import { acceptCrewShift, openCrewShifts } from "@xos/data/gateway";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";
import { outcomeFor } from "@/lib/action-result";
import { CODE_COOKIE } from "@/lib/crew-code-cookie";
import { env } from "@/lib/env";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * A crew access link (B10, ADR 0149 decision 2). A right code is kept in an httpOnly cookie scoped to this link's path for
 * the shorter of 12 hours and the link's life, SameSite=Lax so that opening the link from a text message or a QR scan does
 * not ask again. The token is still required, every request rechecks through the RPC, and accepting runs only here, as a
 * same-origin server action. The code itself never goes in a URL. The cookie is Secure whenever Gateway is served over
 * https, as every other Gateway cookie is: WebKit refuses a Secure cookie from plain http, even on 127.0.0.1, so local
 * http kept no code and each accept counted as a wrong one (nightly run 43452754701).
 */

const TWELVE_HOURS = 12 * 60 * 60;
const token = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const code = z.string().trim().min(4).max(32);

export interface CrewAccessState {
  readonly refusal?: string;
  readonly outcome?: string;
  readonly accepted?: boolean;
  readonly at?: number;
}

const pathOf = (t: string) => `/shifts/${t}`;
const secureSite = () => env().GATEWAY_SITE_URL.startsWith("https:");

export async function openCrewShiftsAction(
  _: CrewAccessState,
  form: FormData,
): Promise<CrewAccessState> {
  const t = token.safeParse(form.get("token"));
  const c = code.safeParse(form.get("accessCode"));
  if (!t.success || !c.success) return { refusal: "crew_access_access_code", at: Date.now() };
  const result = await openCrewShifts(await createServerSupabase(), {
    token: t.data,
    accessCode: c.data,
  });
  if (!result.ok) return { outcome: outcomeFor(result.error), at: Date.now() };
  if (result.data.refused) return { refusal: result.data.reason, at: Date.now() };
  const left = Math.floor((Date.parse(result.data.linkExpiresAt) - Date.now()) / 1000);
  (await cookies()).set(CODE_COOKIE, c.data, {
    httpOnly: true,
    secure: secureSite(),
    sameSite: "lax",
    path: pathOf(t.data),
    maxAge: Math.max(1, Math.min(TWELVE_HOURS, left)),
  });
  revalidatePath(pathOf(t.data));
  return { at: Date.now() };
}

export async function acceptCrewShiftAction(
  _: CrewAccessState,
  form: FormData,
): Promise<CrewAccessState> {
  const t = token.safeParse(form.get("token"));
  const shift = z.uuid().safeParse(form.get("shiftId"));
  if (!t.success || !shift.success) return { refusal: "crew_access_shift_state", at: Date.now() };
  const saved = (await cookies()).get(CODE_COOKIE)?.value ?? "";
  const result = await acceptCrewShift(await createServerSupabase(), {
    token: t.data,
    accessCode: saved,
    shiftId: shift.data,
  });
  if (!result.ok) return { outcome: outcomeFor(result.error), at: Date.now() };
  if (result.data.refused) return { refusal: result.data.reason, at: Date.now() };
  revalidatePath(pathOf(t.data));
  return { accepted: true, at: Date.now() };
}

export async function forgetCrewCodeAction(form: FormData): Promise<void> {
  const t = token.safeParse(form.get("token"));
  if (!t.success) return;
  (await cookies()).set(CODE_COOKIE, "", {
    httpOnly: true,
    secure: secureSite(),
    sameSite: "lax",
    path: pathOf(t.data),
    maxAge: 0,
  });
  revalidatePath(pathOf(t.data));
}
