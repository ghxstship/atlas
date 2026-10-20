"use server";

import { listMyAccounts } from "@xos/data/gateway";
import { cookies } from "next/headers";
import { z } from "zod";
import { LOCALE_COOKIE, selectableLocales } from "@/i18n/negotiate";
import { env } from "@/lib/env";
import { createServerSupabase } from "@/lib/supabase/server";
import { THEME_COOKIE, THEME_PREFERENCES } from "@/lib/theme";
import { PREFERENCES_COOKIE, decodePreferences, encodePreferences } from "@xos/ui/preferences";
import { ACTING_COOKIE } from "./standing";

/**
 * Device preferences set from the Gateway shell: language, theme and the account this device acts
 * for. They live in httpOnly, SameSite=Lax cookies until personal preferences (Section 4.5.6, A30)
 * store them per person. The acting account is checked against the person's own accounts.
 */
const YEAR = 60 * 60 * 24 * 365;

async function setPreference(name: string, value: string): Promise<void> {
  (await cookies()).set(name, value, {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: env().GATEWAY_SITE_URL.startsWith("https:"),
    maxAge: YEAR,
  });
}

export async function setLocale(locale: string): Promise<void> {
  const allowed = selectableLocales(process.env.NODE_ENV === "production") as string[];
  await setPreference(LOCALE_COOKIE, z.enum(allowed as [string, ...string[]]).parse(locale));
}

export async function setTheme(preference: string): Promise<void> {
  const value = z.enum(THEME_PREFERENCES).parse(preference);
  if (value === "system") {
    (await cookies()).delete(THEME_COOKIE);
    return;
  }
  await setPreference(THEME_COOKIE, value);
}

/**
 * Keeps the display preferences cookie (text size, contrast, motion, shortcuts, date format, units, week
 * start) in step with the person's settings, so the server renders the next page with them (A65-001).
 */
export async function syncPreferences(encoded: string): Promise<void> {
  const value = encodePreferences(decodePreferences(z.string().max(200).parse(encoded)));
  if (value === "") (await cookies()).delete(PREFERENCES_COOKIE);
  else await setPreference(PREFERENCES_COOKIE, value);
}

/** Acts for oneself (`self`) or for one of the person's external accounts. */
export async function setActing(accountId: string): Promise<void> {
  if (accountId === "self") {
    await setPreference(ACTING_COOKIE, "self");
    return;
  }
  const id = z.uuid().parse(accountId);
  const accounts = await listMyAccounts(await createServerSupabase());
  if (!accounts.ok) throw new Error(`Accounts could not be read: ${accounts.error.kind}`);
  if (!accounts.data.some((a) => a.id === id)) throw new Error("Not an account of this person.");
  await setPreference(ACTING_COOKIE, id);
}
