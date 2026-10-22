"use server";

import {
  CONSENT_COOKIE,
  consentCookieOptions,
  newVisitorId,
  preferenceCookieOptions,
  recordCookieConsent,
  serializeConsent,
} from "@xos/data/consent";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { LOCALE_COOKIE } from "@/i18n/negotiate";
import { getRequestFacts } from "@/lib/shell/context";
import { createServerSupabase } from "@/lib/supabase/server";
import { THEME_COOKIE } from "@/lib/theme";
import { consentState, secureCookies } from "./consent";

/** The Preferences cookies Gateway sets (legal/cookie-policy.md section 3). */
const PREFERENCE_COOKIES = [LOCALE_COOKIE, THEME_COOKIE] as const;

/**
 * Saves the visitor's cookie choice from the banner or the Cookie settings page (Section 14.3): the
 * decision goes to the server-side consent log with the org whose white-labeled Gateway showed the
 * banner, then the consent cookie is set. Refusing Preferences turns the existing Preferences cookies
 * into cookies that end with the visit; Global Privacy Control refuses every non-essential category.
 */
export async function saveCookieChoice(form: FormData): Promise<void> {
  const choice = form.get("choice");
  const [state, facts] = await Promise.all([consentState(), getRequestFacts()]);
  const all = choice === "all";
  const custom = choice === "save";
  const preferences = !state.gpc && (all || (custom && form.get("preferences") === "on"));
  const performance = !state.gpc && (all || (custom && form.get("performance") === "on"));
  const consent = {
    visitorId: state.consent?.visitorId ?? newVisitorId(),
    preferences,
    performance,
    gpc: state.gpc,
  };
  const orgSlug = facts.brand.kind === "org" ? facts.brand.org.slug : null;
  const recorded = await recordCookieConsent(await createServerSupabase(), consent, orgSlug);
  if (!recorded.ok) console.error("cookie consent was not recorded", recorded.error);

  const store = await cookies();
  const secure = secureCookies();
  store.set(CONSENT_COOKIE, serializeConsent(consent), consentCookieOptions(secure));
  if (!preferences) {
    for (const name of PREFERENCE_COOKIES) {
      const value = store.get(name)?.value;
      if (value !== undefined) store.set(name, value, preferenceCookieOptions(false, secure));
    }
  }
  revalidatePath("/", "layout");
}
