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
import { LAST_ORG_COOKIE } from "@/lib/shell/last-org";
import { WORKSPACE_COOKIE } from "@/lib/shell/workspace";
import { createServerSupabase } from "@/lib/supabase/server";
import { THEME_COOKIE } from "@/lib/theme";
import { consentState, secureCookies } from "./consent";
import { observability } from "@/lib/observability";

/** The Preferences cookies Atlas sets (legal/cookie-policy.md section 3). */
const PREFERENCE_COOKIES = [
  LOCALE_COOKIE,
  THEME_COOKIE,
  WORKSPACE_COOKIE,
  LAST_ORG_COOKIE,
] as const;

/**
 * Saves the visitor's cookie choice from the banner or the Cookie settings page (Section 14.3): the
 * decision goes to the server-side consent log (api_public.record_cookie_consent) with the visitor id
 * the consent cookie holds, then the consent cookie is set. Refusing Preferences turns the existing
 * Preferences cookies into cookies that end with the visit. A browser sending Global Privacy Control
 * refuses every non-essential category whatever was ticked. Plain forms, so the banner works before
 * any script loads.
 */
export async function saveCookieChoice(form: FormData): Promise<void> {
  const choice = form.get("choice");
  const state = await consentState();
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
  const recorded = await recordCookieConsent(await createServerSupabase(), consent);
  if (!recorded.ok)
    observability.logger.error("cookie consent was not recorded", { error: recorded.error });

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
